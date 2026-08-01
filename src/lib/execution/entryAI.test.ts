import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/analysis/indicators";
import {
  DEFAULT_WEIGHTS, chooseOrderType, classifyEntryTiming, classifySession,
  distanceScore, dynamicFrame, evaluateEntryTiming, expectedValueR, gradeFor,
  liquidityPools, liquiditySweep, managementPlan, marketStructure,
  multiTimeframeConfirmation, normalizeWeights, pullbackScore, reoptimizeWeights,
  sessionScore, volatilityEngine, vwap, welchTTest, winProbability,
} from "./entryAI";

function series(prices: number[], vol = 1000): Candle[] {
  return prices.map((p, i) => ({
    ts: i * 60_000,
    open: p * 0.999, high: p * 1.002, low: p * 0.998, close: p, volume: vol,
  }));
}

const uptrend = series(Array.from({ length: 120 }, (_, i) => 100 + i * 0.5));
const downtrend = series(Array.from({ length: 120 }, (_, i) => 160 - i * 0.5));

describe("vwap", () => {
  it("returns a price inside the candle range", () => {
    const v = vwap(uptrend, 60)!;
    expect(v).toBeGreaterThan(120);
    expect(v).toBeLessThan(160);
  });
  it("returns null with no candles", () => {
    expect(vwap([], 10)).toBeNull();
  });
});

describe("market structure", () => {
  it("detects a bullish break of structure in an uptrend", () => {
    expect(marketStructure(uptrend)).toBe("bos_up");
  });
  it("detects a bearish break of structure in a downtrend", () => {
    expect(marketStructure(downtrend)).toBe("bos_down");
  });
  it("returns none on flat data", () => {
    expect(marketStructure(series(new Array(60).fill(100)))).toBe("none");
  });
});

describe("liquidity", () => {
  it("maps equal-high and equal-low pools", () => {
    const choppy = series(Array.from({ length: 120 }, (_, i) => 100 + (i % 4) * 0.05));
    expect(liquidityPools(choppy).length).toBeGreaterThan(0);
  });
  it("flags a sweep when price wicks below prior lows and reclaims", () => {
    const base = Array.from({ length: 40 }, () => 100);
    const candles = series([...base, 100, 100, 100, 100, 100]);
    candles[candles.length - 2] = { ...candles[candles.length - 2], low: 96, close: 100.5 };
    expect(liquiditySweep(candles, "buy")).toBe(true);
  });
});

describe("sessions", () => {
  it("classifies the London/NY overlap", () => {
    expect(classifySession(new Date(Date.UTC(2026, 0, 5, 14)))).toBe("london_ny_overlap");
  });
  it("classifies the Asian session", () => {
    expect(classifySession(new Date(Date.UTC(2026, 0, 5, 3)))).toBe("asian");
  });
  it("blends measured stats into the base score", () => {
    const poor = sessionScore("london", [{ session: "london", trades: 40, winRate: 0.2, expectancy: -0.4 }]);
    expect(poor).toBeLessThan(85);
  });
  it("ignores tiny samples", () => {
    expect(sessionScore("london", [{ session: "london", trades: 3, winRate: 0, expectancy: -1 }])).toBe(85);
  });
});

describe("volatility engine", () => {
  it("marks a flat market as untradeable", () => {
    const flat: Candle[] = Array.from({ length: 120 }, (_, i) => ({
      ts: i * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 1000,
    }));
    const v = volatilityEngine(flat, null);
    expect(v === null || v.tradable === false).toBe(true);
  });

  it("rejects spreads over budget", () => {
    const v = volatilityEngine(uptrend, 80, 30)!;
    expect(v.spreadOk).toBe(false);
    expect(v.tradable).toBe(false);
  });
});

describe("multi-timeframe confirmation", () => {
  it("confirms when the higher timeframes agree", () => {
    const r = multiTimeframeConfirmation(
      { "1d": "bullish", "4h": "bullish", "1h": "bullish", "15m": "bullish", "5m": "neutral" }, "buy");
    expect(r.confirmed).toBe(true);
    expect(r.score).toBeGreaterThan(85);
  });
  it("rejects when a higher timeframe opposes", () => {
    const r = multiTimeframeConfirmation(
      { "1d": "bearish", "4h": "bullish", "1h": "bullish", "15m": "bullish", "5m": "bullish" }, "buy");
    expect(r.confirmed).toBe(false);
  });
});

describe("scoring helpers", () => {
  it("scores distance inversely to ATR multiples", () => {
    expect(distanceScore(0, 1)).toBe(100);
    expect(distanceScore(2, 1, 2)).toBe(0);
    expect(distanceScore(1, 1, 2)).toBe(50);
  });
  it("prefers a moderate pullback over a chase", () => {
    const chase = pullbackScore(uptrend, "buy");
    expect(chase.score).toBeLessThan(60);
  });
  it("grades scores", () => {
    expect(gradeFor(95)).toBe("A+");
    expect(gradeFor(83)).toBe("A");
    expect(gradeFor(40)).toBe("F");
  });
  it("normalises weights to 1", () => {
    const w = normalizeWeights({ ...DEFAULT_WEIGHTS, mtf: 5 });
    const total = Object.values(w).reduce((s, x) => s + x, 0);
    expect(total).toBeCloseTo(1, 2);
  });
});

describe("entry timing", () => {
  const mtf = multiTimeframeConfirmation(
    { "1d": "bullish", "4h": "bullish", "1h": "bullish", "15m": "bullish", "5m": "bullish" }, "buy");
  it("produces a bounded score with all components", () => {
    const r = evaluateEntryTiming({ candles: uptrend, side: "buy", mtf })!;
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.components).toHaveLength(8);
  });
  it("returns null without enough candles", () => {
    expect(evaluateEntryTiming({ candles: series([1, 2, 3]), side: "buy", mtf })).toBeNull();
  });
  it("scores a counter-trend short lower than an aligned long", () => {
    const long = evaluateEntryTiming({ candles: uptrend, side: "buy", mtf })!;
    const shortMtf = multiTimeframeConfirmation(
      { "1d": "bullish", "4h": "bullish", "1h": "bullish", "15m": "bullish", "5m": "bullish" }, "sell");
    const short = evaluateEntryTiming({ candles: uptrend, side: "sell", mtf: shortMtf })!;
    expect(long.score).toBeGreaterThan(short.score);
  });
});

describe("order type selection", () => {
  it("uses a stop entry on a fresh breakout", () => {
    const p = chooseOrderType({ side: "buy", price: 100, atr: 1, retrace: 0.05, structure: "bos_up", volatility: "normal", vwap: 99 });
    expect(p.type).toBe("stop");
    expect(p.price!).toBeGreaterThan(100);
  });
  it("uses a limit entry into a deep pullback", () => {
    const p = chooseOrderType({ side: "buy", price: 100, atr: 1, retrace: 0.5, structure: "none", volatility: "normal", vwap: 99 });
    expect(p.type).toBe("limit");
    expect(p.price!).toBeLessThan(100);
  });
  it("uses market on a clean continuation", () => {
    expect(chooseOrderType({ side: "sell", price: 100, atr: 1, retrace: 0.25, structure: "none", volatility: "normal", vwap: 101 }).type).toBe("market");
  });
});

describe("dynamic frame", () => {
  it("keeps the stop between 1.5 and 3 ATR and RR inside 2..5", () => {
    const f = dynamicFrame({ candles: uptrend, side: "buy", volatility: "normal", adxValue: 30, entryScore: 88 })!;
    expect(f.stopAtrMult).toBeGreaterThanOrEqual(1.4);
    expect(f.stopAtrMult).toBeLessThanOrEqual(3.01);
    expect(f.riskReward).toBeGreaterThanOrEqual(2);
    expect(f.riskReward).toBeLessThanOrEqual(5);
    expect(f.stopLoss).toBeLessThan(f.entry);
    expect(f.takeProfit).toBeGreaterThan(f.entry);
  });
  it("inverts the frame for a short", () => {
    const f = dynamicFrame({ candles: downtrend, side: "sell", volatility: "normal", adxValue: 25, entryScore: 80 })!;
    expect(f.stopLoss).toBeGreaterThan(f.entry);
    expect(f.takeProfit).toBeLessThan(f.entry);
  });
  it("caps reward in extreme volatility", () => {
    const f = dynamicFrame({ candles: uptrend, side: "buy", volatility: "extreme", adxValue: 45, entryScore: 99 })!;
    expect(f.riskReward).toBeLessThanOrEqual(2.5);
  });
});

describe("management plan", () => {
  it("closes 25% at 1R, 2R and 3R with break-even at 1R", () => {
    const p = managementPlan("normal");
    expect(p.breakEvenAtR).toBe(1);
    expect(p.trailStartR).toBe(2);
    expect(p.partials.map(x => x.atR)).toEqual([1, 2, 3]);
    expect(p.partials.every(x => x.closePct === 0.25)).toBe(true);
  });
});

describe("expectancy", () => {
  it("rises with entry score", () => {
    expect(winProbability(90, true)).toBeGreaterThan(winProbability(60, true));
  });
  it("computes R expectancy", () => {
    expect(expectedValueR(0.5, 3)).toBeCloseTo(1, 5);
  });
});

describe("learning", () => {
  it("does nothing below the sample floor", () => {
    expect(reoptimizeWeights(DEFAULT_WEIGHTS, [], 50).changed).toBe(false);
  });
  it("raises the weight of a component that predicts winners", () => {
    const samples = Array.from({ length: 80 }, (_, i) => ({
      components: { ...Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map(k => [k, 50])), mtf: i % 2 ? 90 : 20 },
      rMultiple: i % 2 ? 2 : -1,
    }));
    const out = reoptimizeWeights(DEFAULT_WEIGHTS, samples, 50);
    expect(out.changed).toBe(true);
    expect(out.weights.mtf).toBeGreaterThan(DEFAULT_WEIGHTS.mtf);
  });
  it("classifies entry timing", () => {
    expect(classifyEntryTiming({ maxAdverseExcursionR: 1, maxFavorableExcursionR: 2, rMultiple: 2 })).toBe("early");
    expect(classifyEntryTiming({ maxAdverseExcursionR: 0.1, maxFavorableExcursionR: 2, rMultiple: 0.1 })).toBe("late");
    expect(classifyEntryTiming({ maxAdverseExcursionR: 0.1, maxFavorableExcursionR: 3, rMultiple: 3 })).toBe("perfect");
    expect(classifyEntryTiming({ maxAdverseExcursionR: 1, maxFavorableExcursionR: 0.1, rMultiple: -1 })).toBe("invalid");
  });
});

describe("welch t-test", () => {
  it("finds a clearly better sample significant", () => {
    const a = Array.from({ length: 60 }, (_, i) => 1.5 + (i % 5) * 0.1);
    const b = Array.from({ length: 60 }, (_, i) => -0.4 + (i % 5) * 0.1);
    const r = welchTTest(a, b);
    expect(r.significant).toBe(true);
    expect(r.confidence).toBeGreaterThan(95);
  });
  it("does not promote identical samples", () => {
    const a = Array.from({ length: 40 }, (_, i) => (i % 7) * 0.2 - 0.5);
    expect(welchTTest(a, [...a]).significant).toBe(false);
  });
  it("is inconclusive on tiny samples", () => {
    expect(welchTTest([1, 2], [0, 1]).pValue).toBe(1);
  });
});
