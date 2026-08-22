import { describe, it, expect } from "vitest";
import { computeDynamicSize, convictionScalar } from "./dynamicSizing";

const base = {
  equity: 1000,
  availableBalance: 1000,
  confidence: 0.9,
  minConfidence: 0.5,
  riskPct: 0.005,
  entry: 100,
  stopLoss: 98,
};

describe("dynamic position sizing", () => {
  it("scales with confidence", () => {
    const low = computeDynamicSize({ ...base, confidence: 0.6 });
    const high = computeDynamicSize({ ...base, confidence: 0.98 });
    expect(high.qty).toBeGreaterThan(low.qty);
    expect(convictionScalar(0.98, 0.5)).toBeLessThanOrEqual(1);
  });

  it("scales with equity instead of a fixed dollar cap", () => {
    const small = computeDynamicSize({ ...base, equity: 100, availableBalance: 100 });
    const big = computeDynamicSize({ ...base, equity: 10_000, availableBalance: 10_000 });
    expect(big.notional).toBeGreaterThan(small.notional * 10 - 1);
    expect(big.notional).not.toBeCloseTo(10, 2);
  });

  it("never risks more than the risk budget", () => {
    const r = computeDynamicSize(base);
    expect(r.qty * r.stopDistance).toBeLessThanOrEqual(base.equity * base.riskPct + 1e-6);
  });

  it("never exceeds available funds", () => {
    const r = computeDynamicSize({ ...base, availableBalance: 20, stopLoss: 99.99 });
    expect(r.notional).toBeLessThanOrEqual(18);
    expect(r.binding).toBe("available_balance");
  });

  it("respects portfolio exposure headroom", () => {
    const r = computeDynamicSize({ ...base, exposureHeadroom: 5 });
    expect(r.notional).toBeLessThanOrEqual(5);
    expect(r.binding).toBe("portfolio_exposure");
  });

  it("rounds quantity down so notional never exceeds the ceiling", () => {
    const r = computeDynamicSize({ ...base, qtyPrecision: 2 });
    expect(r.notional).toBeLessThanOrEqual(r.maxNotional + 1e-9);
    expect(Number(r.qty.toFixed(2))).toBe(r.qty);
  });

  it("requires a stop-loss", () => {
    const r = computeDynamicSize({ ...base, stopLoss: null });
    expect(r.qty).toBe(0);
    expect(r.skipReason).toMatch(/stop-loss/);
  });

  it("caps spot disposals at inventory", () => {
    const r = computeDynamicSize({ ...base, maxQty: 0.01, availableBalance: 1000 });
    expect(r.qty).toBeLessThanOrEqual(0.01);
  });
});
