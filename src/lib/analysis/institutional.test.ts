import { describe, expect, it } from "vitest";
import { adx, buildRiskFrame, correlation, performanceStats, trendBias } from "./institutional";
import type { Candle } from "./indicators";
import { checkEventWindow } from "./eventWindow";

function series(prices: number[]): Candle[] {
  return prices.map((p, i) => ({
    ts: i * 900_000,
    open: p * 0.999, high: p * 1.004, low: p * 0.996, close: p, volume: 1000 + i,
  }));
}

const uptrend = series(Array.from({ length: 120 }, (_, i) => 100 + i * 0.8));
const downtrend = series(Array.from({ length: 120 }, (_, i) => 200 - i * 0.8));

describe("adx", () => {
  it("reports strong trend strength on a clean uptrend", () => {
    const a = adx(uptrend, 14);
    expect(a).not.toBeNull();
    expect(a!.adx).toBeGreaterThan(20);
    expect(a!.plusDi).toBeGreaterThan(a!.minusDi);
  });

  it("returns null without enough bars", () => {
    expect(adx(series([1, 2, 3]), 14)).toBeNull();
  });
});

describe("buildRiskFrame", () => {
  it("places a buy stop below entry and target above with the requested RR", () => {
    const f = buildRiskFrame(uptrend, "buy", { minRR: 2, maxRR: 4, preferredRR: 2.5 });
    expect(f).not.toBeNull();
    expect(f!.stopLoss).toBeLessThan(f!.entry);
    expect(f!.takeProfit).toBeGreaterThan(f!.entry);
    expect(f!.riskReward).toBe(2.5);
    const risk = f!.entry - f!.stopLoss;
    const reward = f!.takeProfit - f!.entry;
    expect(reward / risk).toBeCloseTo(2.5, 3);
  });

  it("mirrors the frame for sells", () => {
    const f = buildRiskFrame(downtrend, "sell", { preferredRR: 3 });
    expect(f!.stopLoss).toBeGreaterThan(f!.entry);
    expect(f!.takeProfit).toBeLessThan(f!.entry);
  });

  it("clamps RR into the configured band", () => {
    const f = buildRiskFrame(uptrend, "buy", { minRR: 2, maxRR: 3, preferredRR: 9 });
    expect(f!.riskReward).toBe(3);
  });
});

describe("performanceStats", () => {
  it("computes profit factor, win rate and expectancy", () => {
    const s = performanceStats([100, -50, 200, -50]);
    expect(s.trades).toBe(4);
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBeCloseTo(3, 5);
    expect(s.expectancy).toBeCloseTo(50, 5);
  });

  it("handles an empty history", () => {
    expect(performanceStats([]).trades).toBe(0);
  });

  it("measures drawdown from the equity peak", () => {
    const s = performanceStats([100, -40, 20]);
    expect(s.maxDrawdownPct).toBeGreaterThan(0);
  });
});

describe("correlation & bias", () => {
  it("returns ~1 for identical series", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(correlation(a, a)).toBeCloseTo(1, 5);
  });

  it("detects bullish and bearish stacks", () => {
    expect(trendBias(uptrend.map(c => c.close))).toBe("bullish");
    expect(trendBias(downtrend.map(c => c.close))).toBe("bearish");
  });
});

describe("event window filter", () => {
  it("blocks Saturdays", () => {
    expect(checkEventWindow(new Date("2026-01-03T12:00:00Z")).active).toBe(true);
  });

  it("blocks the US macro release window", () => {
    const w = checkEventWindow(new Date("2026-01-06T12:35:00Z"));
    expect(w.active).toBe(true);
  });

  it("allows a quiet weekday hour", () => {
    expect(checkEventWindow(new Date("2026-01-06T16:10:00Z")).active).toBe(false);
  });
});
