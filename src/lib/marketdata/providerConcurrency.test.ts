// Integration-style proof that EVERY actual provider historical request —
// including retries — is bounded by the single account-level history gate.
import { describe, it, expect, beforeEach } from "vitest";
import {
  withHistorySlot, resetHistoryGate, historyGateStats,
  MAX_CONCURRENT_HISTORY, noteRateLimited, historyFailureReason,
} from "./historyGate.server";

class FakeProvider {
  active = 0;
  maxObserved = 0;
  calls = 0;
  constructor(private failFirstFor = new Set<string>()) {}
  async request(key: string, signal: AbortSignal): Promise<string> {
    this.calls++;
    this.active++;
    this.maxObserved = Math.max(this.maxObserved, this.active);
    try {
      await new Promise(r => setTimeout(r, 5));
      if (signal.aborted) throw new Error("aborted");
      if (this.failFirstFor.has(key)) {
        this.failFirstFor.delete(key);
        const e = new Error("TooManyRequestsError") as Error & { httpStatus: number };
        e.httpStatus = 429;
        throw e;
      }
      return key;
    } finally {
      this.active--;
    }
  }
}

/** Mirrors the MT5 adapter: one provider call per slot, retry re-acquires. */
async function gatedFetch(provider: FakeProvider, account: string, key: string) {
  const attempt = () => withHistorySlot(account, s => provider.request(key, s), {
    queueWaitMs: 5_000, providerTimeoutMs: 2_000, label: key,
  });
  try {
    return await attempt();
  } catch {
    return await attempt(); // retry MUST take a fresh slot
  }
}

describe("provider historical concurrency", () => {
  beforeEach(() => resetHistoryGate());

  it("never exceeds the account cap across 10 symbols × 3 timeframes + entry + retries", async () => {
    const symbols = ["BTC-USD", "ETH-USD", "SOL-USD", "DOGE-USD", "XRP-USD",
      "US30", "FRA40", "GBP-AUD", "EUR-USD", "XAU-USD"];
    const tfs = ["1d", "4h", "1h", "15m"]; // 15m == entry-gate request
    const failing = new Set(["SOL-USD|1h", "BTC-USD|4h"]);
    const provider = new FakeProvider(failing);
    const jobs = symbols.flatMap(s => tfs.map(tf => gatedFetch(provider, "acct-1", `${s}|${tf}`)));
    const out = await Promise.all(jobs);
    expect(out).toHaveLength(40);
    expect(provider.calls).toBe(42); // 40 + 2 retries
    expect(provider.maxObserved).toBeLessThanOrEqual(MAX_CONCURRENT_HISTORY);
  });

  it("keeps one account's gate separate from another's", async () => {
    const a = new FakeProvider();
    const b = new FakeProvider();
    await Promise.all([
      ...Array.from({ length: 8 }, (_, i) => gatedFetch(a, "acct-A", `A${i}`)),
      ...Array.from({ length: 8 }, (_, i) => gatedFetch(b, "acct-B", `B${i}`)),
    ]);
    expect(a.maxObserved).toBeLessThanOrEqual(MAX_CONCURRENT_HISTORY);
    expect(b.maxObserved).toBeLessThanOrEqual(MAX_CONCURRENT_HISTORY);
  });

  it("collapses capacity to a single request after a provider 429", async () => {
    noteRateLimited("acct-429");
    const provider = new FakeProvider();
    await Promise.all(Array.from({ length: 4 }, (_, i) => gatedFetch(provider, "acct-429", `k${i}`)));
    expect(provider.maxObserved).toBe(1);
    expect(historyGateStats("acct-429").rateLimited).toBe(true);
  });

  it("classifies a provider 429 as rate_limited and frees the slot", async () => {
    const e = Object.assign(new Error("TooManyRequestsError"), { httpStatus: 429 });
    expect(historyFailureReason(e)).toBe("rate_limited");
    await withHistorySlot("acct-2", async () => { throw e; }, { providerTimeoutMs: 500 })
      .catch(() => undefined);
    expect(historyGateStats("acct-2").active).toBe(0);
  });

  it("one symbol failing does not fail the others", async () => {
    const provider = new FakeProvider();
    const results = await Promise.allSettled([
      withHistorySlot("acct-3", () => Promise.reject(new Error("boom")), { providerTimeoutMs: 500 }),
      gatedFetch(provider, "acct-3", "BTC|1h"),
      gatedFetch(provider, "acct-3", "ETH|1h"),
    ]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.status).toBe("fulfilled");
    expect(results[2]!.status).toBe("fulfilled");
  });
});
