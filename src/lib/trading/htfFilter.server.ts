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
import {
  historyFailureReason, historyTimingCursor, historyTimings,
  isDeferralReason, MAX_CONCURRENT_HISTORY, type HistoryFailureReason,
} from "@/lib/marketdata/historyGate.server";

type HtfKey = "d1" | "h4" | "h1";
type HtfInterval = "1d" | "4h" | "1h";

export interface HtfTimeframeTiming {
  timeframe: HtfInterval;
  startedAt: number;
  completedAt: number;
  queueMs: number;
  providerMs: number;
  totalMs: number;
  outcome: "completed" | "failed" | "deferred";
  reason?: string;
}

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
  timings?: Partial<Record<HtfKey, HtfTimeframeTiming>>;
}


async function biasFor(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: "1d" | "4h" | "1h",
  userId?: string | null,
  opts?: { signal?: AbortSignal; queueWaitMs?: number; providerTimeoutMs?: number },
): Promise<{ state: HtfState; reason?: string }> {
  try {
    // Each timeframe has its OWN bounded request. A slow 1D can never block
    // the 4H/1H of the same symbol, nor any other symbol: they are independent
    // promises with independent budgets.
    const { candles } = await fetchCandlesWithSource(supabase, symbol, interval, 220, userId, {
      ...(opts?.signal ? { signal: opts.signal } : {}),
      ...(opts?.queueWaitMs ? { queueWaitMs: opts.queueWaitMs } : {}),
      ...(opts?.providerTimeoutMs ? { providerTimeoutMs: opts.providerTimeoutMs } : {}),
    });
    if (!candles || candles.length < 30) return { state: "unknown", reason: "too_few_candles" };
    const bias = trendBias(candles.map(c => c.close));
    return { state: bias === "bullish" || bias === "bearish" ? bias : "neutral" };
  } catch (e) {
    // Data-plane failure — infrastructure state, explicitly NOT a directional
    // opinion. The reason distinguishes a rate-limited/timed-out provider from
    // an instrument the broker genuinely has no history for.
    return { state: "unavailable", reason: historyFailureReason(e) };
  }
}


export async function checkHtfAlignment(
  supabase: SupabaseClient | null,
  symbol: string,
  side: "buy" | "sell",
  userId?: string | null,
  opts?: { signal?: AbortSignal; queueWaitMs?: number; providerTimeoutMs?: number },
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
): Promise<{ aligned: T[]; verdicts: HtfVerdict[]; unmeasured: number; deferred: string[]; failed: string[]; timings: Record<string, Partial<Record<HtfKey, HtfTimeframeTiming>>> }> {
  const slice = candidates.slice(0, budget);
  const states = slice.map(() => ({
    d1: null, h4: null, h1: null,
  } as Record<HtfKey, { state: HtfState; reason?: string } | null>));
  const timingBySymbol: Record<string, Partial<Record<HtfKey, HtfTimeframeTiming>>> = {};
  const startedAtByTask = new Map<string, number>();
  const historyCursorByTask = new Map<string, number>();
  const deferred: string[] = [];
  const failed: string[] = [];
  // Budget comes from the caller (the cycle owns the clock) instead of a
  // hardcoded 13s that could outlive the remaining cycle budget.
  const deadline = Date.now() + Math.max(3_000, opts?.deadlineMs ?? 13_000);
  // Enforce the stage deadline on work already in flight as well as work not
  // yet started. Without this, a request acquiring a slot near the deadline
  // could retain it for a fresh full provider timeout and starve the next run.
  const stageController = new AbortController();
  const abortStage = () => stageController.abort();
  if (opts?.signal?.aborted) abortStage();
  else opts?.signal?.addEventListener("abort", abortStage, { once: true });
  const deadlineTimer = setTimeout(abortStage, Math.max(1, deadline - Date.now()));
  const intervals: Array<{ key: HtfKey; interval: HtfInterval }> = [
    { key: "d1", interval: "1d" }, { key: "h4", interval: "4h" }, { key: "h1", interval: "1h" },
  ];
  // Candidate-major ordering preserves committee rank. Four task workers fill
  // all four gate slots; a slow timeframe occupies only its own worker instead
  // of blocking every timeframe of every later symbol.
  const tasks = slice.flatMap((candidate, index) =>
    intervals.map(({ key, interval }) => ({ candidate, index, key, interval })));
  let next = 0;
  const historyCursor = historyTimingCursor();
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      const task = tasks[i];
      if (!task) continue;
      const { candidate: c, index, key, interval } = task;
      // Out of budget or cancelled: DEFERRED (never evaluated), not rejected.
      if (opts?.signal?.aborted || stageController.signal.aborted || Date.now() >= deadline) {
        continue;
      }
      const taskId = `${c.symbol}:${interval}`;
      const startedAt = Date.now();
      startedAtByTask.set(taskId, startedAt);
      historyCursorByTask.set(taskId, historyTimingCursor());
      const remainingMs = deadline - startedAt;
      if (remainingMs < 1_000) continue;
      const result = await biasFor(supabase, c.symbol, interval, userId, {
          signal: stageController.signal,
          queueWaitMs: Math.max(1_000, Math.min(6_000, remainingMs - 500)),
          providerTimeoutMs: Math.max(1_000, remainingMs - 500),
      });
      states[index]![key] = result;
    }
  };
  try {
    const taskConcurrency = Math.min(MAX_CONCURRENT_HISTORY, Math.max(1, concurrency), tasks.length);
    await Promise.all(Array.from({ length: taskConcurrency }, () => worker()));
  } finally {
    clearTimeout(deadlineTimer);
    opts?.signal?.removeEventListener("abort", abortStage);
  }
  const verdicts: HtfVerdict[] = [];
  for (let index = 0; index < slice.length; index++) {
    const candidate = slice[index]!;
    const state = states[index]!;
    const symbolTimings: Partial<Record<HtfKey, HtfTimeframeTiming>> = {};
    let hasDeferred = false;
    let hasFailure = false;
    for (const { key, interval } of intervals) {
      const result = state[key];
      const taskId = `${candidate.symbol}:${interval}`;
      const taskStart = startedAtByTask.get(taskId);
      const taskHistoryCursor = historyCursorByTask.get(taskId) ?? historyCursor;
      const providerTiming = historyTimings().slice(taskHistoryCursor).find(t =>
        t.label.endsWith(`:${interval}`)
        && (t.label.startsWith(candidate.symbol) || t.label.replace(/[^A-Z0-9]/gi, "").startsWith(candidate.symbol.replace(/[^A-Z0-9]/gi, ""))));
      const reason = result?.reason as HistoryFailureReason | undefined;
      const wasDeferred = !result || (reason ? isDeferralReason(reason) : false);
      hasDeferred ||= wasDeferred;
      hasFailure ||= Boolean(reason && !isDeferralReason(reason) && reason !== "too_few_candles");
      if (taskStart || providerTiming) {
        const completedAt = providerTiming?.finishedAt ?? Date.now();
        symbolTimings[key] = {
          timeframe: interval,
          startedAt: taskStart ?? providerTiming?.queuedAt ?? completedAt,
          completedAt,
          queueMs: providerTiming?.queueMs ?? 0,
          providerMs: providerTiming?.providerMs ?? 0,
          totalMs: providerTiming?.totalMs ?? Math.max(0, completedAt - (taskStart ?? completedAt)),
          outcome: wasDeferred ? "deferred" : reason ? "failed" : "completed",
          ...(reason ? { reason } : {}),
        };
      }
    }
    timingBySymbol[candidate.symbol] = symbolTimings;
    const bias = {
      d1: state.d1?.state ?? "unavailable",
      h4: state.h4?.state ?? "unavailable",
      h1: state.h1?.state ?? "unavailable",
    };
    const want = sideOf(candidate) === "buy" ? "bullish" : "bearish";
    const alignedNow = isHtfAligned(bias, want);
    // A partial result is final only when it already satisfies the unchanged
    // 2-of-3 rule. Otherwise an aborted/unstarted sibling could still change
    // the classification, so preserve it as deferred rather than rejecting it.
    if (hasDeferred && !alignedNow) {
      deferred.push(candidate.symbol);
      continue;
    }
    if (hasFailure && !alignedNow) failed.push(candidate.symbol);
    const dataIssues: Partial<Record<HtfKey, string>> = {};
    for (const key of ["d1", "h4", "h1"] as const) if (state[key]?.reason) dataIssues[key] = state[key]?.reason ?? "unknown_error";
    const side = sideOf(candidate);
    const detail = htfTelemetry(bias, side)
      + (Object.keys(dataIssues).length ? ` data=${Object.entries(dataIssues).map(([tf, reason]) => `${tf}:${reason}`).join(",")}` : "");
    verdicts.push({
      symbol: candidate.symbol, side, aligned: alignedNow, bias, dataIssues,
      tally: tallyHtf(bias, want), classification: classifyHtf(bias, want), detail,
      timings: symbolTimings,
    });
  }
  const alignedSymbols = new Set(verdicts.filter(verdict => verdict.aligned).map(verdict => verdict.symbol));
  const aligned = slice.filter(candidate => alignedSymbols.has(candidate.symbol));
  return {
    aligned, verdicts,
    unmeasured: candidates.length - slice.length + deferred.length,
    deferred: [...new Set(deferred)], failed: [...new Set(failed)], timings: timingBySymbol,
  };
}
