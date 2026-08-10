// Real higher-timeframe pre-filter.
//
// The committee used to approximate a higher-timeframe bias by resampling the
// 200-bar 15m series into 4h buckets. That only yields ~12 buckets, which is
// below the minimum sample the resampler needs, so it silently fell back to the
// raw 15m closes — i.e. the "HTF bias" was really an entry-timeframe bias.
// Counter-trend candidates therefore sailed through the pre-filter and were
// then killed by the authoritative entry gate on "Higher-timeframe alignment",
// burning every candidate slot in the cycle.
//
// This module performs the *same* check the entry gate performs (1D / 4H / 1H
// via real broker candles), so a candidate that reaches the gate can no longer
// fail on alignment.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandlesWithSource } from "@/lib/marketdata/service.server";
import { trendBias } from "@/lib/analysis/institutional";

export interface HtfVerdict {
  symbol: string;
  side: "buy" | "sell";
  aligned: boolean;
  bias: { d1: string; h4: string; h1: string };
  detail: string;
}

async function biasFor(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: "1d" | "4h" | "1h",
  userId?: string | null,
): Promise<string> {
  try {
    const { candles } = await fetchCandlesWithSource(supabase, symbol, interval, 220, userId);
    if (!candles || candles.length < 30) return "neutral";
    return trendBias(candles.map(c => c.close));
  } catch {
    return "unknown";
  }
}

/** Mirrors the entry gate rule: >= 2 of 3 higher timeframes agree and none oppose. */
export async function checkHtfAlignment(
  supabase: SupabaseClient | null,
  symbol: string,
  side: "buy" | "sell",
  userId?: string | null,
): Promise<HtfVerdict> {
  const want = side === "buy" ? "bullish" : "bearish";
  const [d1, h4, h1] = await Promise.all([
    biasFor(supabase, symbol, "1d", userId),
    biasFor(supabase, symbol, "4h", userId),
    biasFor(supabase, symbol, "1h", userId),
  ]);
  const all = [d1, h4, h1];
  if (all.every(b => b === "unknown")) {
    return { symbol, side, aligned: false, bias: { d1, h4, h1 }, detail: "htf candles unavailable" };
  }
  const agree = all.filter(b => b === want).length;
  const oppose = all.filter(b => b !== want && b !== "neutral" && b !== "unknown").length;
  return {
    symbol, side,
    aligned: agree >= 2 && oppose === 0,
    bias: { d1, h4, h1 },
    detail: `1D ${d1}, 4H ${h4}, 1H ${h1} — ${agree}/3 agree with ${side.toUpperCase()}`,
  };
}

/**
 * Filter candidates down to those whose direction agrees with the real higher
 * timeframes. Runs with a small worker pool so MetaApi rate limits are
 * respected, and only inspects `budget` candidates per cycle.
 */
export async function filterHtfAligned<T extends { symbol: string }>(
  supabase: SupabaseClient | null,
  candidates: T[],
  sideOf: (c: T) => "buy" | "sell",
  userId?: string | null,
  budget = 20,
  concurrency = 4,
): Promise<{ aligned: T[]; verdicts: HtfVerdict[] }> {
  const slice = candidates.slice(0, budget);
  const verdicts: Array<HtfVerdict | null> = new Array(slice.length).fill(null);
  let next = 0;
  const deadline = Date.now() + 13_000;
  const worker = async () => {
    while (next < slice.length && Date.now() < deadline) {
      const i = next++;
      const c = slice[i]!;
      try {
        verdicts[i] = await checkHtfAlignment(supabase, c.symbol, sideOf(c), userId);
      } catch {
        // A slow/unavailable broker symbol must not discard verdicts already
        // completed in this bounded batch.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));
  const aligned = slice.filter((_, i) => verdicts[i]?.aligned);
  return { aligned, verdicts: verdicts.filter((v): v is HtfVerdict => v !== null) };
}
