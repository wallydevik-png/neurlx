import { describe, expect, it } from "vitest";
import {
  windowMetrics, strategyScore, stateFromScore, allocationForScore,
  shadowToPaperChecks, liveDemotionCheck, detectDrift, walkForward,
  bootstrapSuperiority, type LcTrade,
} from "./metrics";

const t = (pnl: number, i: number, regime = "trending", confidence = 0.9): LcTrade => ({
  ts: 1_700_000_000_000 + i * 3600_000,
  pnl, rMultiple: pnl > 0 ? 2 : -1, regime,
  slippage: 0, spread: 0, latencyMs: 100, confidence, holdingMs: 3600_000,
});

const winners = (n: number, from = 0) => Array.from({ length: n }, (_, i) => t(200, from + i));
const losers = (n: number, from = 0) => Array.from({ length: n }, (_, i) => t(-100, from + i));

describe("windowMetrics", () => {
  it("handles empty input", () => {
    expect(windowMetrics([]).trades).toBe(0);
  });
  it("computes profit factor and win rate", () => {
    const m = windowMetrics([...winners(6), ...losers(4)]);
    expect(m.trades).toBe(10);
    expect(m.winRate).toBeCloseTo(0.6);
    expect(m.profitFactor).toBeCloseTo(3);
    expect(m.expectancy).toBeCloseTo(80);
  });
  it("counts consecutive losses from the tail", () => {
    expect(windowMetrics([...winners(3), ...losers(5)]).consecutiveLosses).toBe(5);
  });
});

describe("score and state mapping", () => {
  it("scores a strong strategy above the live threshold", () => {
    const trades = Array.from({ length: 200 }, (_, i) => t(i % 3 === 0 ? -80 : 150, i));
    expect(strategyScore(windowMetrics(trades))).toBeGreaterThan(50);
  });
  it("maps score bands to states", () => {
    expect(stateFromScore(85)).toBe("live");
    expect(stateFromScore(70)).toBe("paper");
    expect(stateFromScore(55)).toBe("shadow");
    expect(stateFromScore(20)).toBe("disabled");
  });
  it("allocates capital by score, only when live", () => {
    expect(allocationForScore(92, "live")).toBe(1.0);
    expect(allocationForScore(88, "live")).toBe(0.75);
    expect(allocationForScore(82, "live")).toBe(0.5);
    expect(allocationForScore(95, "paper")).toBe(0);
  });
});

describe("promotion and demotion rules", () => {
  it("blocks shadow promotion below 100 trades", () => {
    const checks = shadowToPaperChecks(windowMetrics(winners(50)));
    expect(checks.find(c => c.label.includes("100"))?.passed).toBe(false);
  });
  it("demotes on five consecutive losses", () => {
    const trades = [...winners(30), ...losers(5)];
    const v = liveDemotionCheck(windowMetrics(trades, 50), windowMetrics(trades, 100), windowMetrics(trades, 300),
      detectDrift(trades));
    expect(v.demote).toBe(true);
    expect(v.reasons.join()).toContain("consecutive");
  });
  it("disables after ten consecutive losses", () => {
    const trades = [...winners(30), ...losers(10)];
    const v = liveDemotionCheck(windowMetrics(trades, 50), windowMetrics(trades, 100), windowMetrics(trades, 300),
      detectDrift(trades));
    expect(v.disable).toBe(true);
  });
});

describe("walk-forward and statistics", () => {
  it("produces sliding windows over a long history", () => {
    const trades = Array.from({ length: 500 }, (_, i) => t(i % 4 === 0 ? -100 : 150, i));
    const wf = walkForward(trades);
    expect(wf.windows.length).toBeGreaterThan(0);
    expect(wf.passRate).toBeGreaterThan(0);
  });
  it("finds a clearly superior candidate significant", () => {
    const baseline = Array.from({ length: 100 }, (_, i) => (i % 2 ? 10 : -9));
    const candidate = Array.from({ length: 100 }, (_, i) => (i % 2 ? 40 : -5));
    expect(bootstrapSuperiority(candidate, baseline).significant).toBe(true);
  });
  it("flags drift when recent performance collapses", () => {
    const trades = [...Array.from({ length: 300 }, (_, i) => t(i % 3 === 0 ? -80 : 160, i)),
      ...losers(50, 300)];
    expect(detectDrift(trades).detected).toBe(true);
  });
});
