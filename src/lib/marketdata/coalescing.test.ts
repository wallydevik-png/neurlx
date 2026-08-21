// Coalescing guarantees for the per-cycle candle cache.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const getCandles = vi.fn();

vi.mock("./mt5Provider.server", () => ({
  resolveUserMt5Connector: async () => ({ id: "mt5" }),
  createMt5MarketDataProvider: () => ({
    id: "mt5:mt5",
    displayName: "MT5 (live)",
    supports: () => true,
    getCandles: (...a: unknown[]) => getCandles(...a),
    getLastPrice: async () => 1,
  }),
  listMt5TradableSymbols: async () => null,
}));

const { fetchCandlesWithSource, resetCandleCache } = await import("./service.server");

const bars = (n: number) => Array.from({ length: n }, (_, i) => ({
  ts: i * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1,
}));

describe("candle request coalescing", () => {
  beforeEach(() => { resetCandleCache(); getCandles.mockReset(); });
  afterEach(() => resetCandleCache());

  it("shares ONE provider request across duplicate consumers", async () => {
    getCandles.mockImplementation(async () => { await new Promise(r => setTimeout(r, 30)); return bars(50); });
    const all = await Promise.all([
      fetchCandlesWithSource(null, "BTC-USD", "1d", 220, "u1"),
      fetchCandlesWithSource(null, "BTC-USD", "1d", 220, "u1"),
      fetchCandlesWithSource(null, "BTC-USD", "1d", 220, "u1"),
    ]);
    expect(getCandles).toHaveBeenCalledTimes(1);
    expect(all.every(r => r.candles.length === 50)).toBe(true);
  });

  it("starts fresh work instead of joining a shared request already aborted by all consumers", async () => {
    let calls = 0;
    mockGetCandles.mockImplementation(async (_symbol, _interval, _limit, opts) => {
      calls++;
      if (calls === 1) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            queueMicrotask(() => reject(new Error("aborted")));
          }, { once: true });
        });
      }
      return candles;
    });
    const firstController = new AbortController();
    const first = fetchCandlesWithSource(null, "BTC-USD", "1h", 200, "u1", { signal: firstController.signal });
    firstController.abort();
    const replacement = fetchCandlesWithSource(null, "BTC-USD", "1h", 200, "u1");

    await expect(first).rejects.toMatchObject({ reason: "aborted" });
    await expect(replacement).resolves.toMatchObject({ candles });
    expect(calls).toBe(2);
  });

  it("keeps the shared request alive when one consumer cancels", async () => {
    let sawAbort = false;
    getCandles.mockImplementation(async (_s, _i, _l, opts?: { signal?: AbortSignal }) => {
      opts?.signal?.addEventListener("abort", () => { sawAbort = true; });
      await new Promise(r => setTimeout(r, 60));
      return bars(40);
    });
    const quitter = new AbortController();
    const a = fetchCandlesWithSource(null, "ETH-USD", "4h", 220, "u1", { signal: quitter.signal });
    const b = fetchCandlesWithSource(null, "ETH-USD", "4h", 220, "u1");
    await new Promise(r => setTimeout(r, 10));
    quitter.abort();
    await expect(a).rejects.toThrow(/cancelled/);
    await expect(b).resolves.toMatchObject({ isSynthetic: false });
    expect(sawAbort).toBe(false);
    expect(getCandles).toHaveBeenCalledTimes(1);
  });

  it("cancels the underlying request once every consumer walks away", async () => {
    let sawAbort = false;
    getCandles.mockImplementation(async (_s, _i, _l, opts?: { signal?: AbortSignal }) => {
      opts?.signal?.addEventListener("abort", () => { sawAbort = true; });
      await new Promise(r => setTimeout(r, 60));
      return bars(40);
    });
    const c = new AbortController();
    const p = fetchCandlesWithSource(null, "SOL-USD", "1h", 220, "u1", { signal: c.signal });
    await new Promise(r => setTimeout(r, 5));
    c.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(sawAbort).toBe(true);
  });

  it("never caches a failure as market data", async () => {
    getCandles.mockRejectedValueOnce(new Error("provider did not respond"));
    await expect(fetchCandlesWithSource(null, "BTC-USD", "1h", 220, "u1")).rejects.toThrow();
    getCandles.mockResolvedValueOnce(bars(30));
    const ok = await fetchCandlesWithSource(null, "BTC-USD", "1h", 220, "u1");
    expect(ok.candles).toHaveLength(30);
    expect(getCandles).toHaveBeenCalledTimes(2);
  });

  it("keeps symbols and timeframes isolated", async () => {
    getCandles.mockImplementation(async (s: string) => (s === "BTC-USD" ? bars(10) : bars(20)));
    const [btc, eth] = await Promise.all([
      fetchCandlesWithSource(null, "BTC-USD", "1d", 220, "u1"),
      fetchCandlesWithSource(null, "ETH-USD", "1d", 220, "u1"),
    ]);
    expect(btc.candles).toHaveLength(10);
    expect(eth.candles).toHaveLength(20);
    expect(getCandles).toHaveBeenCalledTimes(2);
  });
});
