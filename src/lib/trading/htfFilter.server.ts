// Real higher-timeframe pre-filter.
//
// Performs the *same* check the authoritative entry gate performs (1D / 4H /
// 1H via real broker candles), so a candidate that reaches the gate can no
// longer fail on alignment.
//
// Each timeframe reports an explicit state:
//   bullish | bearish | neutral  → measured
//   unknown                      → candles returned but too few to measure
//   unavailable                  → the candles could not be fetched at all
// Missing data is never reported as a contradiction.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandlesWithSource } from "@/lib/marketdata/service.server";
import { trendBias } from "@/lib/analysis/institutional";
import {
  isHtfAligned, tallyHtf, classifyHtf, htfTelemetry,
  type HtfTally, type HtfClassification, type HtfState,
} from "@/lib/trading/htfAlignment";

export interface HtfVerdict {
  symbol: string;
  side: "buy" | "sell";
  aligned: boolean;
  bias: { d1: HtfState; h4: HtfState; h1: HtfState };
  tally: HtfTally;
  classification: HtfClassification;
  detail: string;
}

async function biasFor(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: "1d" | "4h" | "1h",
  userId?: string | null,
): Promise<HtfState> {
  try {
    const { candles } = await fetchCandlesWithSource(supabase, symbol, interval, 220, userId);
    if (!candles || candles.length < 30) return "unknown";
    const bias = trendBias(candles.map(c => c.close));
    return bias === "bullish" || bias === "bearish" ? bias : "neutral";
  } catch {
    // Data-plane failure — explicitly NOT a directional opinion.
    return "unavailable";
  }
}

export async function checkHtfAlignment(
  supabase: SupabaseClient | null,
  symbol: string,
  side: "buy" | "sell",
  userId?: string | null,
): Promise<HtfVerdict> {
  const want = side === "buy" ? "bullish" : "bearish";
  // Independent per-timeframe boundaries: one failing timeframe degrades to
  // "unavailable" instead of discarding the other two.
  const [d1, h4, h1] = await Promise.all([
    biasFor(supabase, symbol, "1d", userId),
    biasFor(supabase, symbol, "4h", userId),
    biasFor(supabase, symbol, "1h", userId),
  ]);
  const bias = { d1, h4, h1 };
  return {
    symbol, side,
    aligned: isHtfAligned(bias, want),
    bias,
    tally: tallyHtf(bias, want),
    classification: classifyHtf(bias, want),
    detail: htfTelemetry(bias, side),
  };
}

/**
 * Filter candidates down to those whose direction agrees with the real higher
 * timeframes. Runs with a small worker pool so MetaApi rate limits are
 * respected, and only inspects `budget` candidates per cycle. Each candidate
 * has an isolated promise, error boundary and result slot: one slow or failing
 * symbol can never discard verdicts already completed by the others.
 */
export async function filterHtfAligned<T extends { symbol: string }>(
  supabase: SupabaseClient | null,
  candidates: T[],
  sideOf: (c: T) => "buy" | "sell",
  userId?: string | null,
  budget = 20,
  concurrency = 4,
): Promise<{ aligned: T[]; verdicts: HtfVerdict[]; unmeasured: number }> {
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
  const measured = verdicts.filter((v): v is HtfVerdict => v !== null);
  return { aligned, verdicts: measured, unmeasured: candidates.length - measured.length };
}
