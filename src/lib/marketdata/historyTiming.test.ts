// Proves the queue/provider split is MEASURED, not guessed, and that a timed
// out request never leaves a slot permanently occupied.
import { describe, it, expect, beforeEach } from "vitest";
import {
  withHistorySlot, resetHistoryGate, historyTimings, historyGateStats,
  MAX_CONCURRENT_HISTORY, HistoryGateError,
} from "./historyGate.server";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("history request lifecycle timing", () => {
  beforeEach(() => resetHistoryGate());

  it("distinguishes queue wait from provider latency", async () => {
    const run = (label: string) => withHistorySlot("acct", async () => {
      await sleep(120);
      return label;
    }, { label, queueWaitMs: 5_000, providerTimeoutMs: 5_000 });

    // One more than the cap, so the last request must queue.
    const labels = Array.from({ length: MAX_CONCURRENT_HISTORY + 1 }, (_, i) => `s${i}:1d`);
    await Promise.all(labels.map(run));

    const t = historyTimings();
    expect(t).toHaveLength(labels.length);
    const first = t.slice(0, MAX_CONCURRENT_HISTORY);
    const queued = t[t.length - 1]!;
    for (const x of first) expect(x.queueMs).toBeLessThan(80);
    expect(queued.queueMs).toBeGreaterThan(80);      // waited for a slot
    expect(queued.providerMs).toBeGreaterThanOrEqual(100); // provider time is its own number
    expect(queued.totalMs).toBeGreaterThanOrEqual(queued.queueMs + queued.providerMs - 5);
  });

  it("attributes a provider timeout to the provider phase and frees the slot", async () => {
    await expect(withHistorySlot("acct", async (signal) => {
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return 1;
    }, { label: "BTC-USD:1d", providerTimeoutMs: 60, abortGraceMs: 20 }))
      .rejects.toThrow(HistoryGateError);

    const last = historyTimings().at(-1)!;
    expect(last.phase).toBe("provider");
    expect(last.reason).toBe("provider_timeout");
    expect(last.queueMs).toBeLessThan(50);
    await sleep(60);
    expect(historyGateStats("acct").active).toBe(0);
  });

  it("attributes a queue timeout to the queue phase, with zero provider time", async () => {
    const hold = Array.from({ length: MAX_CONCURRENT_HISTORY }, () =>
      withHistorySlot("acct", () => sleep(300), { providerTimeoutMs: 2_000 }));
    await sleep(10);
    await expect(withHistorySlot("acct", async () => 1, {
      label: "ETH-USD:4h", queueWaitMs: 40,
    })).rejects.toMatchObject({ reason: "queue_timeout" });

    const failed = historyTimings().find(t => t.label === "ETH-USD:4h")!;
    expect(failed.phase).toBe("queue");
    expect(failed.providerMs).toBe(0);
    expect(failed.queueMs).toBeGreaterThanOrEqual(30);
    await Promise.all(hold);
  });
});
