import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "@/lib/marketdata/types";
import { resetHistoryGate } from "@/lib/marketdata/historyGate.server";
import { resetCandleCache } from "@/lib/marketdata/service.server";

vi.mock("@/lib/marketdata/service.server", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/marketdata/service.server")>();
  return {
    ...actual,
    fetchCandlesWithSource: vi.fn(async (_db, symbol: string, interval: string, _limit, _user, opts) => {
      const delay = interval === "1d" ? 30 : interval === "4h" ? 20 : 10;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      const rising = symbol !== "SELL";
      const candles: Candle[] = Array.from({ length: 40 }, (_, i) => ({
        ts: i, open: rising ? i + 1 : 100 - i, high: rising ? i + 2 : 101 - i,
        low: rising ? i : 99 - i, close: rising ? i + 1.5 : 99.5 - i, volume: 1,
      }));
      return { candles, source: "mt5", isSynthetic: false };
    }),
  };
});

import { filterHtfAligned } from "./htfFilter.server";

describe("HTF task scheduler", () => {
  beforeEach(() => {
    resetHistoryGate();
    resetCandleCache();
  });

  it("evaluates buy and sell directions symmetrically without deferring a healthy batch", async () => {
    const candidates = [{ symbol: "BUY", side: "buy" as const }, { symbol: "SELL", side: "sell" as const }];
    const result = await filterHtfAligned(null, candidates, c => c.side, null, 2, 4, { deadlineMs: 2_000 });

    expect(result.deferred).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.aligned.map(candidate => candidate.symbol)).toEqual(["BUY", "SELL"]);
    expect(result.verdicts).toHaveLength(2);
  });

  it("preserves completed timeframe data when the remaining stage is aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);
    const result = await filterHtfAligned(
      null, [{ symbol: "BUY", side: "buy" as const }], c => c.side,
      null, 1, 1, { signal: controller.signal, deadlineMs: 2_000 },
    );

    expect(result.deferred).toEqual(["BUY"]);
    expect(Object.keys(result.timings.BUY ?? {}).length).toBeGreaterThan(0);
  });
});