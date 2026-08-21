import { describe, it, expect, beforeEach } from "vitest";
import {
  withHistorySlot, historyGateStats, resetHistoryGate,
  historyFailureReason, isDeferralReason,
  MAX_CONCURRENT_HISTORY, HistoryGateError,
} from "./historyGate.server";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("history gate concurrency", () => {
  beforeEach(() => resetHistoryGate());

  it("never exceeds the provider cap for 10 symbols x 3 timeframes", async () => {
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 30 }, (_, i) =>
      withHistorySlot("acct", async () => {
        active++;
        peak = Math.max(peak, active);
        await sleep(5);
        active--;
        return i;
      }, { queueWaitMs: 5_000 }));
    const out = await Promise.all(calls);
    expect(out).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_HISTORY);
    expect(peak).toBeLessThanOrEqual(5);
    expect(historyGateStats("acct").active).toBe(0);
  });

  it("queues the extra request until a slot frees", async () => {
    const release: Array<() => void> = [];
    const started: number[] = [];
    const run = (i: number) => withHistorySlot("acct", async () => {
      started.push(i);
      await new Promise<void>(r => release.push(r));
    }, { queueWaitMs: 5_000, providerTimeoutMs: 5_000 });
    const all = [0, 1, 2, 3, 4, 5].map(run);
    await sleep(10);
    expect(started).toHaveLength(MAX_CONCURRENT_HISTORY);
    expect(historyGateStats("acct").queued).toBe(6 - MAX_CONCURRENT_HISTORY);
    release.forEach(r => r());
    await sleep(10);
    release.forEach(r => r());
    await Promise.all(all);
    expect(started).toHaveLength(6);
  });

  it("releases the slot when a request fails with 429", async () => {
    const err = Object.assign(new Error("TooManyRequestsError"), { httpStatus: 429 });
    const failures = Array.from({ length: MAX_CONCURRENT_HISTORY }, () =>
      withHistorySlot("acct", async () => { throw err; }).catch(e => e));
    await Promise.all(failures);
    expect(historyGateStats("acct").active).toBe(0);
    await expect(withHistorySlot("acct", async () => "ok")).resolves.toBe("ok");
  });

  it("aborts the provider request when the slot budget expires", async () => {
    let sawAbort = false;
    const reason = await withHistorySlot("acct", (signal) => new Promise((_res, rej) => {
      signal.addEventListener("abort", () => { sawAbort = true; rej(new Error("aborted")); });
    }), { providerTimeoutMs: 20 }).catch((e: unknown) => (e as HistoryGateError).reason);
    expect(sawAbort).toBe(true);
    expect(reason).toBe("provider_timeout");
    await sleep(20);
    expect(historyGateStats("acct").active).toBe(0);
    expect(historyGateStats("acct").inFlight).toBe(0);
  });

  it("keeps in-flight work inside the cap even when callers time out", async () => {
    // Work that ignores the abort must still be counted: the gate may not hand
    // its slot to a new provider request while it is genuinely running.
    const stubborn = Array.from({ length: MAX_CONCURRENT_HISTORY }, () =>
      withHistorySlot("acct", () => sleep(120).then(() => "late"),
        { providerTimeoutMs: 10, abortGraceMs: 200 }).catch(() => "timeout"));
    await sleep(60);
    expect(historyGateStats("acct").inFlightPeak).toBeLessThanOrEqual(MAX_CONCURRENT_HISTORY);
    await Promise.all(stubborn);
    expect(historyGateStats("acct").inFlight).toBe(0);
  });

  it("one symbol timing out does not cancel the others", async () => {
    const slow = withHistorySlot("acct", (s) => new Promise<string>((res, rej) => {
      const t = setTimeout(() => res("slow"), 500);
      s.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
    }), { providerTimeoutMs: 20 })
      .catch((e: unknown) => (e as HistoryGateError).reason);
    const fast = await Promise.all([1, 2, 3].map(i =>
      withHistorySlot("acct", async () => i)));
    expect(fast).toEqual([1, 2, 3]);
    expect(await slow).toBe("provider_timeout");
    expect(historyGateStats("acct").active).toBe(0);
  });

  it("defers instead of hanging when the queue stays saturated", async () => {
    const holders = Array.from({ length: MAX_CONCURRENT_HISTORY }, () =>
      withHistorySlot("acct", () => sleep(200), { providerTimeoutMs: 1_000 }));
    const deferred = await withHistorySlot("acct", async () => "never", { queueWaitMs: 20 })
      .catch((e: unknown) => (e as HistoryGateError).reason);
    expect(deferred).toBe("queue_timeout");
    expect(isDeferralReason("queue_timeout")).toBe(true);
    await Promise.all(holders);
  });

  it("a cycle abort releases queued waiters instead of stranding them", async () => {
    const controller = new AbortController();
    const holders = Array.from({ length: MAX_CONCURRENT_HISTORY }, () =>
      withHistorySlot("acct", () => sleep(150), { providerTimeoutMs: 1_000 }));
    const queued = withHistorySlot("acct", async () => "never",
      { queueWaitMs: 5_000, signal: controller.signal })
      .catch((e: unknown) => (e as HistoryGateError).reason);
    await sleep(10);
    controller.abort();
    expect(await queued).toBe("aborted");
    expect(isDeferralReason("aborted")).toBe(true);
    await Promise.all(holders);
  });

  it("classifies provider failures as infrastructure state, not direction", () => {
    expect(historyFailureReason(Object.assign(new Error("x"), { httpStatus: 429 }))).toBe("rate_limited");
    expect(historyFailureReason(new Error("Request to mt5 timed out after 6000ms"))).toBe("provider_timeout");
    expect(historyFailureReason(new HistoryGateError("q", "saturated"))).toBe("saturated");
    expect(historyFailureReason(new Error("Account not connected"))).toBe("connection_error");
    expect(historyFailureReason(new Error("boom"))).toBe("unknown_error");
    expect(isDeferralReason("rate_limited")).toBe(false);
  });
});
