// Institutional-grade technical + statistical primitives.
// Pure functions, no I/O — safe to unit test and to import anywhere.
import type { Candle } from "./indicators";
import { atr, ema, sma } from "./indicators";

// ---------------------------------------------------------------------------
// Trend strength — Wilder's ADX
// ---------------------------------------------------------------------------
export interface AdxOut { adx: number; plusDi: number; minusDi: number; }

export function adx(candles: Candle[], period = 14): AdxOut | null {
  if (candles.length < period * 2 + 1) return null;
  const trs: number[] = [], plusDm: number[] = [], minusDm: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  // Wilder smoothing
  const smooth = (arr: number[]) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) { s = s - s / period + arr[i]; out.push(s); }
    return out;
  };
  const strs = smooth(trs), sPlus = smooth(plusDm), sMinus = smooth(minusDm);
  const dx: number[] = [];
  for (let i = 0; i < strs.length; i++) {
    if (strs[i] === 0) { dx.push(0); continue; }
    const pdi = (sPlus[i] / strs[i]) * 100;
    const mdi = (sMinus[i] / strs[i]) * 100;
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }
  if (dx.length < period) return null;
  const adxV = sma(dx, period);
  const last = strs.length - 1;
  if (adxV === null || strs[last] === 0) return null;
  return {
    adx: adxV,
    plusDi: (sPlus[last] / strs[last]) * 100,
    minusDi: (sMinus[last] / strs[last]) * 100,
  };
}

// ---------------------------------------------------------------------------
// Swing structure — last confirmed swing high/low (fractal, 2-bar shoulders)
// ---------------------------------------------------------------------------
export function lastSwingHigh(candles: Candle[], lookback = 60): number | null {
  const c = candles.slice(-lookback);
  for (let i = c.length - 3; i >= 2; i--) {
    if (c[i].high > c[i - 1].high && c[i].high > c[i - 2].high
      && c[i].high > c[i + 1].high && c[i].high > c[i + 2].high) return c[i].high;
  }
  return c.length ? Math.max(...c.map(x => x.high)) : null;
}

export function lastSwingLow(candles: Candle[], lookback = 60): number | null {
  const c = candles.slice(-lookback);
  for (let i = c.length - 3; i >= 2; i--) {
    if (c[i].low < c[i - 1].low && c[i].low < c[i - 2].low
      && c[i].low < c[i + 1].low && c[i].low < c[i + 2].low) return c[i].low;
  }
  return c.length ? Math.min(...c.map(x => x.low)) : null;
}

// ---------------------------------------------------------------------------
// Structural SL/TP builder — 1.5 ATR or last swing, whichever is WIDER.
// RR clamped to the configured [min, max] band (spec: 1:2 .. 1:4, prefer 1:2.5)
// ---------------------------------------------------------------------------
export interface RiskFrame {
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskReward: number;
  stopDistance: number;
  basis: "atr" | "swing";
  atr: number;
}

export function buildRiskFrame(
  candles: Candle[],
  side: "buy" | "sell",
  opts: { atrMult?: number; minRR?: number; preferredRR?: number; maxRR?: number } = {},
): RiskFrame | null {
  const last = candles[candles.length - 1]?.close;
  const a = atr(candles, 14);
  if (!last || !a || a <= 0) return null;
  const atrMult = opts.atrMult ?? 1.5;
  const minRR = opts.minRR ?? 2;
  const maxRR = opts.maxRR ?? 4;
  const preferredRR = Math.min(maxRR, Math.max(minRR, opts.preferredRR ?? 2.5));

  const atrDist = a * atrMult;
  const swing = side === "buy" ? lastSwingLow(candles) : lastSwingHigh(candles);
  const swingDist = swing !== null ? Math.abs(last - swing) : 0;
  // "whichever is larger" — never a tighter stop than structure demands.
  const basis: "atr" | "swing" = swingDist > atrDist ? "swing" : "atr";
  // Cap runaway structural stops at 4 ATR so one wide swing can't blow risk out.
  const stopDistance = Math.min(Math.max(atrDist, swingDist), a * 4);
  if (!(stopDistance > 0)) return null;

  const dir = side === "buy" ? 1 : -1;
  const stopLoss = +(last - dir * stopDistance).toFixed(8);
  const takeProfit = +(last + dir * stopDistance * preferredRR).toFixed(8);
  return {
    entry: +last.toFixed(8), stopLoss, takeProfit,
    riskReward: preferredRR, stopDistance, basis, atr: a,
  };
}

// ---------------------------------------------------------------------------
// Performance statistics (used by the self-learning evaluator + dashboard)
// ---------------------------------------------------------------------------
export interface PerfStats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  avgR: number;
  sharpe: number;
  sortino: number;
  maxDrawdownPct: number;
}

export function performanceStats(pnls: number[], rMultiples: number[] = []): PerfStats {
  const n = pnls.length;
  if (n === 0) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, expectancy: 0,
      avgWin: 0, avgLoss: 0, avgR: 0, sharpe: 0, sortino: 0, maxDrawdownPct: 0 };
  }
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const grossWin = wins.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
  const mean = pnls.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  const downside = pnls.filter(x => x < 0);
  const dsd = downside.length
    ? Math.sqrt(downside.reduce((s, x) => s + x ** 2, 0) / downside.length)
    : 0;

  // Equity-curve drawdown from cumulative P&L
  let cum = 0, peak = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    if (peak > 0) maxDd = Math.max(maxDd, ((peak - cum) / peak) * 100);
  }

  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    expectancy: mean,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    avgR: rMultiples.length ? rMultiples.reduce((s, x) => s + x, 0) / rMultiples.length : 0,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(Math.min(n, 252)) : 0,
    sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(Math.min(n, 252)) : 0,
    maxDrawdownPct: +maxDd.toFixed(2),
  };
}

// Pearson correlation of log returns — shared by the correlation engine.
export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < n; i++) {
    if (a[i - 1] <= 0 || b[i - 1] <= 0) continue;
    ra.push(Math.log(a[i] / a[i - 1]));
    rb.push(Math.log(b[i] / b[i - 1]));
  }
  if (ra.length < 4) return 0;
  const ma = ra.reduce((s, x) => s + x, 0) / ra.length;
  const mb = rb.reduce((s, x) => s + x, 0) / rb.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

// Higher-timeframe bias from EMA 50/200 stack — used by the MTF gate.
export function trendBias(closes: number[]): "bullish" | "bearish" | "neutral" {
  const e50 = ema(closes, 50);
  const e200 = ema(closes, Math.min(200, Math.max(50, closes.length - 1)));
  if (e50 === null || e200 === null) return "neutral";
  const spread = (e50 - e200) / e200;
  if (spread > 0.001) return "bullish";
  if (spread < -0.001) return "bearish";
  return "neutral";
}
