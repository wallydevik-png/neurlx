import { describe, it, expect, beforeEach } from "vitest";
import {
  withHistorySlot, historyGateStats, resetHistoryGate,
  historyFailureReason, MAX_CONCURRENT_HISTORY, HistoryGateError,
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
      }));
    const out = await Promise.all(calls);
    expect(out).toHaveLength(30);
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_HISTORY);
    expect(peak).toBeLessThanOrEqual(5);
    expect(historyGateStats("acct").active).toBe(0);
  });

  it("queues the 6th request until a slot frees", async () => {
    const release: Array<() => void> = [];
    const started: number[] = [];
    const run = (i: number) => withHistorySlot("acct", async () => {
      started.push(i);
      await new Promise<void>(r => release.push(r));
    });
    const all = [0, 1, 2, 3, 4, 5].map(run);
    await sleep(10);
    expect(started).toEqual([0, 1, 2, 3].slice(0, MAX_CONCURRENT_HISTORY));
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

  it("one symbol timing out does not cancel the others", async () => {
    const slow = withHistorySlot("acct", () => sleep(500).then(() => "slow"), { maxHoldMs: 20 })
      .catch((e: unknown) => (e as HistoryGateError).reason);
    const fast = await Promise.all([1, 2, 3].map(i =>
      withHistorySlot("acct", async () => i)));
    expect(fast).toEqual([1, 2, 3]);
    expect(await slow).toBe("timeout");
    expect(historyGateStats("acct").active).toBe(0);
  });

  it("defers instead of hanging when the queue stays saturated", async () => {
    const holders = Array.from({ length: MAX_CONCURRENT_HISTORY }, () =>
      withHistorySlot("acct", () => sleep(200)));
    const deferred = await withHistorySlot("acct", async () => "never", { waitMs: 20 })
      .catch((e: unknown) => (e as HistoryGateError).reason);
    expect(deferred).toBe("saturated");
    await Promise.all(holders);
  });

  it("classifies provider failures as infrastructure state, not direction", () => {
    expect(historyFailureReason(Object.assign(new Error("x"), { httpStatus: 429 }))).toBe("rate_limited");
    expect(historyFailureReason(new Error("Request to mt5 timed out after 6000ms"))).toBe("timeout");
    expect(historyFailureReason(new HistoryGateError("q", "saturated"))).toBe("saturated");
    expect(historyFailureReason(new Error("boom"))).toBe("error");
  });
});
