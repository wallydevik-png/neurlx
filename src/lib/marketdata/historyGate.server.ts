// Account-level gate for historical market-data requests.
//
// MetaApi hard-caps historical market-data at 5 CONCURRENT requests per
// account and answers with `429 TooManyRequestsError` above that. Previously
// each module bounded its own symbol-level concurrency, which said nothing
// about how many *provider* requests were in flight: 4 symbols x 3 higher
// timeframes = 12 simultaneous history calls, so the cap was breached and the
// resulting 429s surfaced as "HTF unavailable".
//
// This module is the ONE place that limits provider history calls. Every
// consumer (HTF filter, momentum, entry gate, scanner) reaches the provider
// through it, so the account-level invariant is:
//
//     active history requests for an account <= MAX_CONCURRENT_HISTORY
//
// at all times. Waiters are queued FIFO and run as slots free up — no sleeps,
// no per-module pools, and a slot is always released, including on failure.

export const MAX_CONCURRENT_HISTORY = 4; // stay safely under the provider's 5

export type HistoryFailureReason =
  | "rate_limited"
  | "timeout"
  | "saturated"
  | "error";

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
}

const gates = new Map<string, GateState>();

function gateFor(key: string): GateState {
  let g = gates.get(key);
  if (!g) {
    g = { active: 0, queue: [], peak: 0 };
    gates.set(key, g);
  }
  return g;
}

function release(g: GateState) {
  g.active = Math.max(0, g.active - 1);
  // FIFO hand-off: the longest-waiting caller takes the freed slot.
  while (g.queue.length && g.active < MAX_CONCURRENT_HISTORY) {
    const w = g.queue.shift()!;
    if (w.done) continue;
    w.done = true;
    if (w.timer) clearTimeout(w.timer);
    g.active++;
    g.peak = Math.max(g.peak, g.active);
    w.resolve();
  }
}

function acquire(g: GateState, waitMs: number): Promise<void> {
  if (g.active < MAX_CONCURRENT_HISTORY) {
    g.active++;
    g.peak = Math.max(g.peak, g.active);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const w: Waiter = { resolve, reject, timer: null, done: false };
    w.timer = setTimeout(() => {
      if (w.done) return;
      w.done = true;
      const i = g.queue.indexOf(w);
      if (i >= 0) g.queue.splice(i, 1);
      reject(new HistoryGateError(
        `history request queue saturated after ${waitMs}ms — symbol deferred`,
        "saturated",
      ));
    }, waitMs);
    g.queue.push(w);
  });
}

export interface HistorySlotOptions {
  /** How long a caller may wait for a free slot before deferring. */
  waitMs?: number;
  /** Hard ceiling on how long one provider call may hold its slot. */
  maxHoldMs?: number;
}

/**
 * Runs `fn` while holding one of the account's history slots. The slot is
 * released on success, failure, and hold-timeout alike, so one stalled or
 * rate-limited symbol can never strand capacity for the others.
 */
export async function withHistorySlot<T>(
  accountKey: string,
  fn: () => Promise<T>,
  opts: HistorySlotOptions = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 15_000;
  const maxHoldMs = opts.maxHoldMs ?? 12_000;
  const g = gateFor(accountKey || "default");
  await acquire(g, waitMs);
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await new Promise<T>((resolve, reject) => {
      holdTimer = setTimeout(
        () => reject(new HistoryGateError(
          `history request exceeded ${maxHoldMs}ms slot budget`,
          "timeout",
        )),
        maxHoldMs,
      );
      fn().then(resolve, reject);
    });
  } finally {
    if (holdTimer) clearTimeout(holdTimer);
    release(g);
  }
}

/** Classifies a provider/data-plane failure. Infrastructure state only — this
 *  is never a directional (bullish/bearish) opinion. */
export function historyFailureReason(e: unknown): HistoryFailureReason {
  if (e instanceof HistoryGateError) return e.reason;
  const err = e as { httpStatus?: number; name?: string; message?: string };
  const msg = err?.message ?? String(e ?? "");
  if (err?.httpStatus === 429 || /TooManyRequests|rate limit/i.test(msg)) return "rate_limited";
  if (err?.name === "AbortError" || /timed out|timeout/i.test(msg)) return "timeout";
  return "error";
}

/** Test/telemetry hooks. */
export function historyGateStats(accountKey = "default") {
  const g = gates.get(accountKey);
  return { active: g?.active ?? 0, queued: g?.queue.length ?? 0, peak: g?.peak ?? 0 };
}

export function resetHistoryGate() {
  for (const g of gates.values()) {
    for (const w of g.queue) if (w.timer) clearTimeout(w.timer);
  }
  gates.clear();
}
