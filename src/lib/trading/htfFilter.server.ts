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
  /** Why a timeframe is unknown/unavailable: rate_limited, timeout, saturated,
   *  error, or too_few_candles. Infrastructure state, never a direction. */
  dataIssues: Partial<Record<"d1" | "h4" | "h1", string>>;
  tally: HtfTally;
  classification: HtfClassification;
  detail: string;
}


async function biasFor(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: "1d" | "4h" | "1h",
  userId?: string | null,
  opts?: { signal?: AbortSignal; queueWaitMs?: number },
): Promise<{ state: HtfState; reason?: string }> {
  try {
    // Each timeframe has its OWN bounded request. A slow 1D can never block
    // the 4H/1H of the same symbol, nor any other symbol: they are independent
    // promises with independent budgets.
    const { candles } = await fetchCandlesWithSource(supabase, symbol, interval, 220, userId, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.queueWaitMs ? { queueWaitMs: opts.queueWaitMs } : {}),
    });
    if (!candles || candles.length < 30) return { state: "unknown", reason: "too_few_candles" };
    const bias = trendBias(candles.map(c => c.close));
    return { state: bias === "bullish" || bias === "bearish" ? bias : "neutral" };
  } catch (e) {
    // Data-plane failure — infrastructure state, explicitly NOT a directional
    // opinion. The reason distinguishes a rate-limited/timed-out provider from
    // an instrument the broker genuinely has no history for.
    const { historyFailureReason } = await import("@/lib/marketdata/historyGate.server");
    return { state: "unavailable", reason: historyFailureReason(e) };
  }
}


export async function checkHtfAlignment(
  supabase: SupabaseClient | null,
  symbol: string,
  side: "buy" | "sell",
  userId?: string | null,
  opts?: { signal?: AbortSignal; queueWaitMs?: number },
): Promise<HtfVerdict> {
  const want = side === "buy" ? "bullish" : "bearish";
  // Independent per-timeframe boundaries: one failing timeframe degrades to
  // "unavailable" instead of discarding the other two. The shared history gate
  // keeps these three requests inside the provider's account-level cap.
  const [d1, h4, h1] = await Promise.all([
    biasFor(supabase, symbol, "1d", userId, opts),
    biasFor(supabase, symbol, "4h", userId, opts),
    biasFor(supabase, symbol, "1h", userId, opts),
  ]);
  const bias = { d1: d1.state, h4: h4.state, h1: h1.state };
  const dataIssues: Partial<Record<"d1" | "h4" | "h1", string>> = {};
  if (d1.reason) dataIssues.d1 = d1.reason;
  if (h4.reason) dataIssues.h4 = h4.reason;
  if (h1.reason) dataIssues.h1 = h1.reason;
  const issueDetail = Object.entries(dataIssues)
    .map(([tf, r]) => `${tf}:${r}`).join(",");
  return {
    symbol, side,
    aligned: isHtfAligned(bias, want),
    bias,
    dataIssues,
    tally: tallyHtf(bias, want),
    classification: classifyHtf(bias, want),
    detail: htfTelemetry(bias, side) + (issueDetail ? ` data=${issueDetail}` : ""),
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
  opts?: { signal?: AbortSignal; deadlineMs?: number },
): Promise<{ aligned: T[]; verdicts: HtfVerdict[]; unmeasured: number; deferred: string[] }> {
  const slice = candidates.slice(0, budget);
  const verdicts: Array<HtfVerdict | null> = new Array(slice.length).fill(null);
  const deferred: string[] = [];
  let next = 0;
  // Budget comes from the caller (the cycle owns the clock) instead of a
  // hardcoded 13s that could outlive the remaining cycle budget.
  const deadline = Date.now() + Math.max(3_000, opts?.deadlineMs ?? 13_000);
  const worker = async () => {
    while (next < slice.length) {
      const i = next++;
      const c = slice[i]!;
      // Out of budget or cancelled: DEFERRED (never evaluated), not rejected.
      if (opts?.signal?.aborted || Date.now() >= deadline) {
        deferred.push(c.symbol);
        continue;
      }
      try {
        verdicts[i] = await checkHtfAlignment(supabase, c.symbol, sideOf(c), userId, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          queueWaitMs: Math.max(1_000, Math.min(6_000, deadline - Date.now())),
        });
      } catch {
        // A slow/unavailable broker symbol must not discard verdicts already
        // completed in this bounded batch.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));
  const aligned = slice.filter((_, i) => verdicts[i]?.aligned);
  const measured = verdicts.filter((v): v is HtfVerdict => v !== null);
  return {
    aligned, verdicts: measured,
    unmeasured: candidates.length - measured.length,
    deferred,
  };
}
