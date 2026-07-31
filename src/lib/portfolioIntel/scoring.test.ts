import { describe, expect, it } from "vitest";
import {
  allocationFromScore, computeHealth, correlationVerdict, gradeTrade, modeConstraints,
  overtradingVerdict, regimeMatrixVerdict, scoreOpportunity, sectorExposure, sectorVerdict,
  proposeCapitalParams, type OpportunityInput, type OpenExposure,
} from "./scoring";
import { assumedCorrelation, sectorOf } from "./sectors";

const baseOpp = (over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  symbol: "BTC-USD", side: "buy", aiConfidence: 0.93, expectedR: 2.4,
  regime: "bull", regimeConfidence: 0.8, regimeFavoursSide: true, trendQuality: 0.8,
  volatilityPct: 0.02, accountDrawdownPct: 0.01, exposurePct: 0.1, correlationPenalty: 1,
  strategy: { winRate50: 0.6, winRate300: 0.58, sharpe: 1.6, profitFactor: 1.9, avgRMultiple: 0.5, expectancy: 40, trades: 220 },
  spreadBps: 2, slippageBps: 3, liquidityScore: 0.9, hourUtc: 14, newsProximityMinutes: 500,
  fundingRate: 0.0001, openInterestChangePct: 2, volumeRatio: 1.3, orderBookImbalance: 0.2,
  ...over,
});

describe("opportunity scoring", () => {
  it("scores an A+ setup high and a poor setup low", () => {
    const good = scoreOpportunity(baseOpp()).score;
    const bad = scoreOpportunity(baseOpp({
      aiConfidence: 0.6, expectedR: 0.8, regime: "panic", regimeFavoursSide: false,
      trendQuality: 0.1, volatilityPct: 0.12, accountDrawdownPct: 0.1, exposurePct: 0.8,
      strategy: { winRate50: 0.3, winRate300: 0.35, sharpe: -0.4, profitFactor: 0.7, avgRMultiple: -0.3, expectancy: -20, trades: 150 },
      spreadBps: 40, slippageBps: 30, liquidityScore: 0.2, hourUtc: 22, newsProximityMinutes: 5,
    })).score;
    expect(good).toBeGreaterThan(75);
    expect(bad).toBeLessThan(50);
    expect(good).toBeGreaterThan(bad + 25);
  });

  it("punishes imminent high-impact news", () => {
    const calm = scoreOpportunity(baseOpp({ newsProximityMinutes: 600 })).score;
    const newsy = scoreOpportunity(baseOpp({ newsProximityMinutes: 4 })).score;
    expect(newsy).toBeLessThan(calm);
  });

  it("keeps the score bounded", () => {
    const s = scoreOpportunity(baseOpp({ aiConfidence: 1, expectedR: 99, trendQuality: 1 })).score;
    expect(s).toBeLessThanOrEqual(100);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe("capital allocation ladder", () => {
  it("follows the mandated ladder", () => {
    expect(allocationFromScore(97)).toBe(1);
    expect(allocationFromScore(92)).toBe(0.8);
    expect(allocationFromScore(87)).toBe(0.6);
    expect(allocationFromScore(82)).toBe(0.4);
    expect(allocationFromScore(77)).toBe(0.2);
    expect(allocationFromScore(74.9)).toBe(0);
  });
});

describe("correlation engine", () => {
  const ltcOpen: OpenExposure[] = [{ symbol: "LTC-USD", side: "long", riskPct: 0.5, notional: 500 }];

  it("cuts correlated allocations", () => {
    const bch = correlationVerdict("BCH-USD", "buy", ltcOpen);
    const eth = correlationVerdict("ETH-USD", "buy", ltcOpen);
    expect(bch.blocked).toBe(false);
    expect(bch.multiplier).toBeLessThan(0.45);
    expect(eth.multiplier).toBeLessThan(1);
    expect(eth.multiplier).toBeGreaterThan(bch.multiplier);
  });

  it("blocks duplicate exposure on the same asset", () => {
    const v = correlationVerdict("LTC-USD", "buy", ltcOpen);
    expect(v.blocked).toBe(true);
    expect(v.reason).toBe("duplicate_exposure");
  });

  it("enforces the correlated risk cap", () => {
    const heavy: OpenExposure[] = [
      { symbol: "ETH-USD", side: "long", riskPct: 1, notional: 1000 },
      { symbol: "SOL-USD", side: "long", riskPct: 1, notional: 1000 },
    ];
    const v = correlationVerdict("AVAX-USD", "buy", heavy, { newRiskPct: 1, maxCorrelatedRiskPct: 2 });
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("correlated_risk_cap");
  });

  it("enforces max crypto beta", () => {
    const book: OpenExposure[] = ["ETH-USD", "SOL-USD", "AVAX-USD", "LINK-USD", "DOT-USD"].map(sym => ({
      symbol: sym, side: "long" as const, riskPct: 1.5, notional: 900,
    }));
    const v = correlationVerdict("BTC-USD", "buy", book, { maxCryptoBetaPct: 4, newRiskPct: 1, maxCorrelatedRiskPct: 99 });
    expect(v.blocked).toBe(true);
    expect(v.reason).toContain("crypto_beta_cap");
  });

  it("treats opposite direction as a partial hedge", () => {
    const same = correlationVerdict("BCH-USD", "buy", ltcOpen).multiplier;
    const hedged = correlationVerdict("BCH-USD", "sell", ltcOpen).multiplier;
    expect(hedged).toBeGreaterThan(same);
  });
});

describe("sector limits", () => {
  it("computes exposure and blocks over-limit sectors", () => {
    const open: OpenExposure[] = [{ symbol: "ETH-USD", side: "long", riskPct: 1, notional: 3000 }];
    const exp = sectorExposure(open, 10000);
    const sec = sectorOf("ETH-USD");
    expect(exp[sec]).toBeCloseTo(30, 1);
    const v = sectorVerdict("SOL-USD", 10, exp, { [sec]: 25 });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("sector_cap");
  });
});

describe("portfolio health and modes", () => {
  const healthy = {
    equity: 10000, openRiskPct: 1, usedMarginPct: 0.1,
    open: [{ symbol: "BTC-USD", side: "long" as const, riskPct: 1, notional: 1000 }],
    drawdownPct: 0.005, maxDrawdownPct: 0.03, realizedPnl: 1200, avgVolatilityPct: 0.02,
    recentReturns: Array.from({ length: 30 }, () => 0.01),
  };

  it("keeps a clean book in normal or aggressive mode", () => {
    const r = computeHealth(healthy, { aggressiveEnabled: false });
    expect(r.healthScore).toBeGreaterThan(70);
    expect(r.mode).toBe("normal");
  });

  it("enters defensive mode on a stressed book", () => {
    const r = computeHealth({
      ...healthy, openRiskPct: 12, usedMarginPct: 0.9, drawdownPct: 0.12,
      realizedPnl: -2000, avgVolatilityPct: 0.12,
      open: Array.from({ length: 6 }, (_, i) => ({ symbol: `ALT${i}-USD`, side: "long" as const, riskPct: 2, notional: 4000 })),
      recentReturns: Array.from({ length: 30 }, () => -0.02),
    });
    expect(r.healthScore).toBeLessThan(50);
    expect(r.mode).toBe("defensive");
  });

  it("defensive constraints cut risk and cap open trades", () => {
    const c = modeConstraints("defensive", 40);
    expect(c.maxOpenTrades).toBe(1);
    expect(c.minConfidence).toBeGreaterThanOrEqual(0.95);
    expect(c.allowMeanReversion).toBe(false);
    expect(c.sizeMultiplier).toBeLessThanOrEqual(0.25);
  });
});

describe("regime matrix veto", () => {
  it("rejects strategies that lose in the current regime", () => {
    const cells = [{ regime: "range", trades: 40, winRate: 0.3, profitFactor: 0.7, expectancy: -12 }];
    expect(regimeMatrixVerdict(cells, "range").allowed).toBe(false);
  });
  it("does not veto on a small sample", () => {
    const cells = [{ regime: "range", trades: 4, winRate: 0.2, profitFactor: 0.4, expectancy: -8 }];
    expect(regimeMatrixVerdict(cells, "range").allowed).toBe(true);
  });
});

describe("overtrading guard", () => {
  const now = Date.now();
  const three = [now - 60_000, now - 120_000, now - 300_000];
  it("blocks a 4th trade below score 95", () => {
    expect(overtradingVerdict(three, now, 88).allowed).toBe(false);
  });
  it("allows an exceptional setup through", () => {
    expect(overtradingVerdict(three, now, 96).allowed).toBe(true);
  });
  it("ignores trades outside the window", () => {
    expect(overtradingVerdict([now - 40 * 60_000], now, 80).allowed).toBe(true);
  });
});

describe("trade quality grading", () => {
  it("grades a clean winner highly", () => {
    const r = gradeTrade({
      plannedEntry: 100, actualEntry: 100.02, plannedStop: 98, plannedTarget: 106, exitPrice: 105.8,
      side: "long", slippageBps: 2, latencyMs: 200, holdingMinutes: 180, plannedHoldingMinutes: 200,
      riskPct: 0.6, plannedRiskPct: 0.6, aiConfidence: 0.94, exitReason: "take_profit",
      manualInterventions: 0, maxFavourableExcursionR: 3, maxAdverseExcursionR: 0.2,
    });
    expect(["A+", "A"]).toContain(r.grade);
    expect(r.overall).toBeGreaterThan(80);
  });

  it("grades a sloppy loser poorly", () => {
    const r = gradeTrade({
      plannedEntry: 100, actualEntry: 101.5, plannedStop: 98, plannedTarget: 106, exitPrice: 97.5,
      side: "long", slippageBps: 150, latencyMs: 5000, holdingMinutes: 4000, plannedHoldingMinutes: 200,
      riskPct: 3, plannedRiskPct: 1, aiConfidence: 0.62, exitReason: "manual",
      manualInterventions: 3, maxFavourableExcursionR: 0.05, maxAdverseExcursionR: 1.4,
    });
    expect(["D", "F"]).toContain(r.grade);
  });
});

describe("self-learning capital engine", () => {
  it("proposes parameters from closed trades", () => {
    const trades = Array.from({ length: 120 }, (_, i) => ({
      pnl: i % 3 === 0 ? -80 : 128,
      rMultiple: i % 3 === 0 ? -1 : 1.6,
      riskPct: 0.8,
      holdingMinutes: 120 + (i % 5) * 30,
      stopAtrMult: 1.5,
      tpRMultiple: 2,
      trailingPct: 0.01,
      strategyId: `s${i % 3}`,
      exitReason: i % 3 === 0 ? "stop_loss" : "take_profit",
    }));
    const p = proposeCapitalParams(trades);
    expect(p.optimalAllocationPct).toBeGreaterThan(0);
    expect(p.optimalAllocationPct).toBeLessThanOrEqual(2);
    expect(p.optimalTpRMultiple).toBeGreaterThan(1);
    expect(p.metrics.expectancyR).toBeGreaterThan(0);
  });
});

describe("sector/correlation primitives", () => {
  it("maps known clusters", () => {
    expect(assumedCorrelation("LTC-USD", "BCH-USD")).toBeGreaterThan(0.85);
    expect(assumedCorrelation("BTC-USD", "EUR/USD")).toBeLessThan(0.4);
    expect(assumedCorrelation("SOL-USD", "SOL-USD")).toBe(1);
  });
});
