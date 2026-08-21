// Account-level gate for historical market-data requests.
//
// MetaApi hard-caps historical market-data at 5 CONCURRENT requests per
// account and answers with `429 TooManyRequestsError` above that. This module
// is the ONE place that limits provider history calls, so the account-level
// invariant is:
//
//     in-flight provider history requests for an account <= MAX_CONCURRENT_HISTORY
//
// Two properties matter and both were previously violated:
//
//  1. A slot must stay occupied until the provider request is genuinely no
//     longer in flight. The old implementation resolved its hold-timeout and
//     released the slot while the underlying fetch kept running, so the real
//     provider concurrency silently exceeded the cap — which is exactly what
//     kept producing 429s after the first "concurrency fix".
//     The gate now owns an AbortSignal, aborts the work on timeout, and waits
//     (briefly) for the aborted work to actually settle before releasing.
//
//  2. "Waiting for a slot" and "provider did not answer" are different
//     failures. They are now reported as `queue_timeout` and `provider_timeout`
//     respectively, never collapsed into a single "timeout".
//
// Nothing here is a directional opinion: every failure is infrastructure state.

export const MAX_CONCURRENT_HISTORY = 4; // stay safely under the provider's 5

export type HistoryFailureReason =
  | "rate_limited"
  | "provider_timeout"
  | "queue_timeout"
  | "provider_unavailable"
  | "connection_error"
  | "provisioning_error"
  | "too_few_candles"
  | "symbol_unavailable"
  | "saturated"
  | "aborted"
  | "unknown_error";

export class HistoryGateError extends Error {
  reason: HistoryFailureReason;
  constructor(message: string, reason: HistoryFailureReason) {
    super(message);
    this.name = "HistoryGateError";
    this.reason = reason;
  }
}

interface Waiter {
  resolve: () => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

interface GateState {
  active: number;
  queue: Waiter[];
  peak: number;
  /** Requests actually handed to the provider and not yet settled. */
  inFlight: number;
  inFlightPeak: number;
  /**
   * Requests we aborted locally. The provider (MetaApi) keeps counting an
   * aborted historical request against the account for a short while, so a
   * locally-freed slot is NOT immediately free provider-side. Each entry is
   * the timestamp until which the slot is still assumed occupied upstream.
   */
  draining: number[];
  /** Set when the provider answered 429: capacity collapses to 1 until then. */
  penaltyUntil: number;
  pump: ReturnType<typeof setTimeout> | null;
}

const gates = new Map<string, GateState>();

/** How long an aborted request is assumed to still occupy a provider slot. */
export const DRAIN_MS = 4_000;
/** How long the account stays at capacity 1 after a provider 429. */
export const RATE_LIMIT_PENALTY_MS = 6_000;

let requestSeq = 0;

function gateFor(key: string): GateState {
  let g = gates.get(key);
  if (!g) {
    g = {
      active: 0, queue: [], peak: 0, inFlight: 0, inFlightPeak: 0,
      draining: [], penaltyUntil: 0, pump: null,
    };
    gates.set(key, g);
  }
  return g;
}

function prune(g: GateState) {
  const now = Date.now();
  if (g.draining.length) g.draining = g.draining.filter(t => t > now);
}

/** Slots we may hand out right now, given drains and rate-limit penalty. */
function capacity(g: GateState): number {
  prune(g);
  const now = Date.now();
  if (g.penaltyUntil > now) return 1;
  return Math.max(1, MAX_CONCURRENT_HISTORY - g.draining.length);
}

/** Called when the provider itself reported a rate limit for this account. */
export function noteRateLimited(accountKey: string) {
  const g = gateFor(accountKey || "default");
  g.penaltyUntil = Date.now() + RATE_LIMIT_PENALTY_MS;
}

function schedulePump(g: GateState) {
  if (g.pump || !g.queue.length) return;
  g.pump = setTimeout(() => {
    g.pump = null;
    pump(g);
    schedulePump(g);
  }, 250);
  (g.pump as unknown as { unref?: () => void }).unref?.();
}

function pump(g: GateState) {
  // FIFO hand-off: the longest-waiting caller takes the freed slot.
  while (g.queue.length && g.active < capacity(g)) {
    const w = g.queue.shift()!;
    if (w.done) continue;
    w.done = true;
    if (w.timer) clearTimeout(w.timer);
    g.active++;
    g.peak = Math.max(g.peak, g.active);
    w.resolve();
  }
  schedulePump(g);
}

function release(g: GateState) {
  g.active = Math.max(0, g.active - 1);
  pump(g);
}

function acquire(g: GateState, queueWaitMs: number, outer?: AbortSignal): Promise<void> {
  if (outer?.aborted) {
    return Promise.reject(new HistoryGateError("cycle aborted before slot admission", "aborted"));
  }
  if (g.active < capacity(g)) {
    g.active++;
    g.peak = Math.max(g.peak, g.active);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { resolve, reject, timer: null, done: false };
    const settleRejected = (e: HistoryGateError) => {
      if (w.done) return;
      w.done = true;
      if (w.timer) clearTimeout(w.timer);
      const i = g.queue.indexOf(w);
      if (i >= 0) g.queue.splice(i, 1);
      reject(e);
    };
    w.timer = setTimeout(() => settleRejected(new HistoryGateError(
      `waited ${queueWaitMs}ms for a history slot — symbol deferred`,
      "queue_timeout",
    )), queueWaitMs);
    // A cycle that ran out of budget must not leave callers queued: the whole
    // point is that a queued request can never hold the cycle hostage.
    outer?.addEventListener("abort", () => settleRejected(new HistoryGateError(
      "cycle aborted while waiting for a history slot", "aborted",
    )), { once: true });
    g.queue.push(w);
    schedulePump(g);
  });
}


/**
 * Full-lifecycle timing for ONE history request. This is what makes the
 * difference between "the queue made us late" and "the provider was slow"
 * measurable instead of guessed.
 */
export interface HistoryTiming {
  id: string;
  account: string;
  label: string;
  /** Time spent waiting for a slot, before any provider work started. */
  queueMs: number;
  /** Time the provider request itself was in flight. */
  providerMs: number;
  totalMs: number;
  active: number;
  queued: number;
  /** Where the request ended up: which phase owns the outcome. */
  phase: "queue" | "provider";
  outcome: "completed" | "failed";
  reason?: HistoryFailureReason;
}

const timings: HistoryTiming[] = [];
const MAX_TIMINGS = 400;

function recordTiming(t: HistoryTiming) {
  timings.push(t);
  if (timings.length > MAX_TIMINGS) timings.splice(0, timings.length - MAX_TIMINGS);
}

/** Recent per-request timings (newest last). Test/telemetry hook. */
export function historyTimings(): HistoryTiming[] {
  return timings.slice();
}

/** Aggregate view used in cycle notes: is queueing or the provider the cost? */
export function historyTimingSummary() {
  return historyTimingSummarySince(0);
}

/** Cursor for cycle-scoped telemetry. Timings are process-global because the
 * semaphore is process-global, but a run must not report every request made by
 * earlier runs (the UI was showing n=373 for a ten-symbol cycle). */
export function historyTimingCursor(): number {
  return timings.length;
}

/** Aggregate only requests recorded after `cursor`. */
export function historyTimingSummarySince(cursor: number) {
  const recent = timings.slice(Math.max(0, cursor));
  if (!recent.length) return null;
  const q = recent.map(t => t.queueMs).sort((a, b) => a - b);
  const p = recent.map(t => t.providerMs).sort((a, b) => a - b);
  const pct = (arr: number[], f: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] ?? 0;
  return {
    n: recent.length,
    queueP50: pct(q, 0.5), queueP95: pct(q, 0.95), queueMax: q[q.length - 1] ?? 0,
    providerP50: pct(p, 0.5), providerP95: pct(p, 0.95), providerMax: p[p.length - 1] ?? 0,
    failed: recent.filter(t => t.outcome === "failed").length,
    queuePhaseFailures: recent.filter(t => t.outcome === "failed" && t.phase === "queue").length,
    providerPhaseFailures: recent.filter(t => t.outcome === "failed" && t.phase === "provider").length,
  };
}

export function resetHistoryTimings() { timings.length = 0; }

export interface HistorySlotOptions {
  /** How long a caller may wait for a free slot before deferring. */
  queueWaitMs?: number;
  /** Hard ceiling on how long ONE provider call may run before it is aborted. */
  providerTimeoutMs?: number;
  /** Grace period to let an aborted request unwind before the slot is reused. */
  abortGraceMs?: number;
  /** Cycle-level cancellation. Aborting stops queued and running work. */
  signal?: AbortSignal;
  /** Telemetry label, e.g. `SOL-USD:1h`. */
  label?: string;
  /** Legacy aliases (kept so existing callers keep compiling). */
  waitMs?: number;
  maxHoldMs?: number;
}

/**
 * Runs `fn` while holding one of the account's history slots.
 *
 * `fn` receives an AbortSignal and MUST pass it to its underlying fetch — that
 * is what makes the slot accounting honest: on timeout or cycle abort the
 * request is really cancelled, not merely abandoned.
 */
export async function withHistorySlot<T>(
  accountKey: string,
  fn: (signal: AbortSignal) => Promise<T>,
  opts: HistorySlotOptions = {},
): Promise<T> {
  const queueWaitMs = opts.queueWaitMs ?? opts.waitMs ?? 8_000;
  const providerTimeoutMs = opts.providerTimeoutMs ?? opts.maxHoldMs ?? 7_000;
  const abortGraceMs = opts.abortGraceMs ?? 1_000;
  const key = accountKey || "default";
  const g = gateFor(key);

  const rid = `h${++requestSeq}`;
  const label = opts.label ?? "";
  const tQueued = Date.now();
  console.log(`[historyGate] history_request_queued ${key}:${label}:${rid} active=${g.active} queued=${g.queue.length}`);
  try {
    await acquire(g, queueWaitMs, opts.signal);
  } catch (e) {
    const reason = historyFailureReason(e);
    const queueMs = Date.now() - tQueued;
    recordTiming({
      id: rid, account: key, label, queueMs, providerMs: 0, totalMs: queueMs,
      active: g.active, queued: g.queue.length, phase: "queue",
      outcome: "failed", reason,
    });
    console.log(`[historyGate] history_request_failed ${key}:${label}:${rid} phase=queue queue_ms=${queueMs} reason=${reason} active=${g.active} queued=${g.queue.length}`);
    throw e;
  }
  const tAcquired = Date.now();
  const queueMs = tAcquired - tQueued;

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, providerTimeoutMs);

  g.inFlight++;
  g.inFlightPeak = Math.max(g.inFlightPeak, g.inFlight);
  console.log(`[historyGate] history_provider_started ${key}:${label}:${rid} queue_ms=${queueMs} active=${g.active} inFlight=${g.inFlight} queued=${g.queue.length}`);
  const finish = (outcome: "completed" | "failed", reason?: HistoryFailureReason) => {
    const now = Date.now();
    const providerMs = now - tAcquired;
    recordTiming({
      id: rid, account: key, label, queueMs, providerMs, totalMs: now - tQueued,
      active: g.active, queued: g.queue.length, phase: "provider", outcome,
      ...(reason ? { reason } : {}),
    });
    console.log(
      `[historyGate] history_request_finished ${key}:${label}:${rid} ` +
      `queue_ms=${queueMs} provider_ms=${providerMs} total_ms=${now - tQueued} ` +
      `active=${g.active} queued=${g.queue.length} outcome=${outcome}${reason ? ` reason=${reason}` : ""}`,
    );
  };


  let settled = false;
  const work = (async () => {
    try {
      return await fn(controller.signal);
    } finally {
      settled = true;
      g.inFlight = Math.max(0, g.inFlight - 1);
    }
  })();
  // Never leave an unhandled rejection behind when we stop awaiting `work`.
  work.catch((e) => {
    // A provider rate limit is account-wide: throttle the whole gate, even if
    // the caller that observed it has already given up.
    if (historyFailureReason(e) === "rate_limited") noteRateLimited(key);
  });

  try {
    if (providerTimeoutMs <= 0) {
      const v = await work;
      finish("completed");
      return v;
    }
    const raced = await Promise.race([
      work.then(v => ({ ok: true as const, v })),
      new Promise<{ ok: false }>(resolve => {
        const t = setTimeout(() => resolve({ ok: false }), providerTimeoutMs + abortGraceMs);
        // Do not keep the runtime alive for the grace timer alone.
        (t as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    if (raced.ok) {
      finish("completed");
      return raced.v;
    }
    throw new HistoryGateError(
      timedOut
        ? `provider did not respond within ${providerTimeoutMs}ms`
        : "history request cancelled",
      timedOut ? "provider_timeout" : "aborted",
    );
  } catch (e) {
    const reason = e instanceof HistoryGateError ? e.reason
      : timedOut ? "provider_timeout"
      : opts.signal?.aborted ? "aborted"
      : historyFailureReason(e);
    finish("failed", reason);

    if (reason === "rate_limited") noteRateLimited(key);
    if (e instanceof HistoryGateError) throw e;
    if (timedOut) {
      throw new HistoryGateError(
        `provider did not respond within ${providerTimeoutMs}ms`, "provider_timeout",
      );
    }
    if (opts.signal?.aborted) {
      throw new HistoryGateError("history request cancelled by cycle budget", "aborted");
    }
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    // Only free the slot once the provider request is genuinely done. If it is
    // still unwinding after the abort grace, release anyway (the request was
    // aborted, so the provider side is closing) but keep the provider-side
    // occupancy honest via the drain window: MetaApi keeps counting an
    // aborted historical request for a short while after we walk away.
    if (!settled) {
      await Promise.race([work.catch(() => undefined), delay(abortGraceMs)]);
      if (!settled) g.draining.push(Date.now() + DRAIN_MS);
    }
    release(g);
  }
}


function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

/** Classifies a provider/data-plane failure. Infrastructure state only — this
 *  is never a directional (bullish/bearish) opinion. */
export function historyFailureReason(e: unknown): HistoryFailureReason {
  if (e instanceof HistoryGateError) return e.reason;
  const err = e as { httpStatus?: number; name?: string; message?: string };
  const msg = err?.message ?? String(e ?? "");
  if (err?.httpStatus === 429 || /TooManyRequests|rate limit/i.test(msg)) return "rate_limited";
  if (/not supported|unsupported symbol|unknown symbol/i.test(msg)) return "symbol_unavailable";
  if (/provisioning|deploy/i.test(msg)) return "provisioning_error";
  if (/not connected|not deployed|does not match the account region/i.test(msg)) return "connection_error";
  if (/cancelled|canceled|aborted/i.test(msg)) return "aborted";
  if (err?.name === "AbortError" || /timed out|timeout/i.test(msg)) return "provider_timeout";
  if ((err?.httpStatus ?? 0) >= 500) return "provider_unavailable";
  return "unknown_error";
}

/** True when the reason means "we never got to ask", not "the market said no". */
export function isDeferralReason(reason: HistoryFailureReason): boolean {
  return reason === "queue_timeout" || reason === "saturated" || reason === "aborted";
}

/** Test/telemetry hooks. */
export function historyGateStats(accountKey = "default") {
  const g = gates.get(accountKey);
  return {
    active: g?.active ?? 0,
    queued: g?.queue.length ?? 0,
    peak: g?.peak ?? 0,
    inFlight: g?.inFlight ?? 0,
    inFlightPeak: g?.inFlightPeak ?? 0,
    draining: g?.draining.filter(t => t > Date.now()).length ?? 0,
    rateLimited: (g?.penaltyUntil ?? 0) > Date.now(),
  };
}

export function resetHistoryGate() {
  for (const g of gates.values()) {
    for (const w of g.queue) if (w.timer) clearTimeout(w.timer);
    if (g.pump) clearTimeout(g.pump);
  }
  gates.clear();
  resetHistoryTimings();
}

