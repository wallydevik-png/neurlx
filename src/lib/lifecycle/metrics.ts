// Pure statistics for the strategy lifecycle engine.
// No IO — safe to import anywhere (also unit-testable).

export type LifecycleState = "shadow" | "paper" | "live" | "disabled";

export interface LcTrade {
  ts: number;              // close time (ms)
  pnl: number;             // realized PnL in account currency
  rMultiple: number;       // realized R
  regime: string;
  slippage: number;
  spread: number;
  latencyMs: number;
  confidence: number;
  holdingMs: number;
}

export interface WindowMetrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;      // avg pnl per trade
  avgR: number;
  avgWin: number;
  avgLoss: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;     // fraction of peak equity, 0..1
  avgHoldingMs: number;
  avgSlippage: number;
  avgSpread: number;
  avgLatencyMs: number;
  executionQuality: number; // 0..1, 1 = frictionless
  consecutiveLosses: number;
  netPnl: number;
}

export const EMPTY_METRICS: WindowMetrics = {
  trades: 0, winRate: 0, profitFactor: 0, expectancy: 0, avgR: 0,
  avgWin: 0, avgLoss: 0, sharpe: 0, sortino: 0, maxDrawdown: 0,
  avgHoldingMs: 0, avgSlippage: 0, avgSpread: 0, avgLatencyMs: 0,
  executionQuality: 1, consecutiveLosses: 0, netPnl: 0,
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Rolling metrics over the last `n` closed trades (chronological input). */
export function windowMetrics(all: LcTrade[], n?: number): WindowMetrics {
  const trades = n ? all.slice(-n) : all;
  if (trades.length === 0) return { ...EMPTY_METRICS };

  const pnls = trades.map(t => t.pnl);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));

  // Equity curve drawdown (relative to running peak of cumulative PnL + base).
  let equity = Math.max(1, Math.abs(grossWin) + Math.abs(grossLoss));
  let peak = equity, maxDd = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - equity) / peak : 0);
  }

  const sd = std(pnls);
  const downside = std(pnls.filter(p => p < 0));
  const m = mean(pnls);
  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i--) { if (trades[i].pnl <= 0) streak++; else break; }

  const avgSlip = mean(trades.map(t => Math.abs(t.slippage)));
  const avgSpread = mean(trades.map(t => Math.abs(t.spread)));
  const avgLat = mean(trades.map(t => t.latencyMs));
  const frictionPenalty = Math.min(1, avgSlip / 0.005) * 0.4
    + Math.min(1, avgSpread / 0.005) * 0.4
    + Math.min(1, avgLat / 2000) * 0.2;

  return {
    trades: trades.length,
    winRate: wins.length / trades.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
    expectancy: m,
    avgR: mean(trades.map(t => t.rMultiple)),
    avgWin: wins.length ? mean(wins) : 0,
    avgLoss: losses.length ? mean(losses) : 0,
    sharpe: sd > 0 ? m / sd : (m > 0 ? 3 : 0),
    sortino: downside > 0 ? m / downside : (m > 0 ? 3 : 0),
    maxDrawdown: maxDd,
    avgHoldingMs: mean(trades.map(t => t.holdingMs)),
    avgSlippage: avgSlip,
    avgSpread: avgSpread,
    avgLatencyMs: avgLat,
    executionQuality: Math.max(0, 1 - frictionPenalty),
    consecutiveLosses: streak,
    netPnl: pnls.reduce((a, b) => a + b, 0),
  };
}

/** Composite 0–100 strategy score. */
export function strategyScore(m: WindowMetrics): number {
  if (m.trades === 0) return 50;
  const norm = (v: number, lo: number, hi: number) =>
    Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const pf = norm(m.profitFactor, 0.8, 2.2);
  const sharpe = norm(m.sharpe, 0, 2);
  const sortino = norm(m.sortino, 0, 2.5);
  const exp = norm(m.expectancy, 0, Math.max(1e-9, Math.abs(m.avgWin) || 1));
  const dd = 1 - norm(m.maxDrawdown, 0.02, 0.15);
  const wr = norm(m.winRate, 0.40, 0.65);
  const eq = Math.max(0, Math.min(1, m.executionQuality));
  const raw = pf * 30 + sharpe * 20 + sortino * 15 + exp * 15 + dd * 10 + wr * 5 + eq * 5;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

export function stateFromScore(score: number): LifecycleState {
  if (score >= 80) return "live";
  if (score >= 65) return "paper";
  if (score >= 50) return "shadow";
  return "disabled";
}

/** Risk % allocated to a strategy given its score. */
export function allocationForScore(score: number, state: LifecycleState): number {
  if (state !== "live") return 0;
  if (score >= 90) return 1.0;
  if (score >= 85) return 0.75;
  if (score >= 80) return 0.5;
  return 0;
}

/** Rolling walk-forward: 300 train / 100 validate, sliding window. */
export interface WalkForwardWindow {
  index: number;
  trainTrades: number;
  validationTrades: number;
  trainProfitFactor: number;
  validationProfitFactor: number;
  trainExpectancy: number;
  validationExpectancy: number;
  degradation: number;   // 1 - (val PF / train PF)
  passed: boolean;
}

export function walkForward(
  all: LcTrade[], train = 300, validate = 100, step = 50,
): { windows: WalkForwardWindow[]; passRate: number; latest: WalkForwardWindow | null } {
  const windows: WalkForwardWindow[] = [];
  // With few trades, degrade gracefully to smaller windows.
  const tw = all.length < train + validate ? Math.max(20, Math.floor(all.length * 0.75)) : train;
  const vw = all.length < train + validate ? Math.max(10, all.length - tw) : validate;
  for (let start = 0, i = 0; start + tw + vw <= all.length; start += step, i++) {
    const trainSet = all.slice(start, start + tw);
    const valSet = all.slice(start + tw, start + tw + vw);
    const tm = windowMetrics(trainSet);
    const vm = windowMetrics(valSet);
    const degradation = tm.profitFactor > 0 ? 1 - vm.profitFactor / tm.profitFactor : 1;
    windows.push({
      index: i, trainTrades: tm.trades, validationTrades: vm.trades,
      trainProfitFactor: +tm.profitFactor.toFixed(3),
      validationProfitFactor: +vm.profitFactor.toFixed(3),
      trainExpectancy: +tm.expectancy.toFixed(4),
      validationExpectancy: +vm.expectancy.toFixed(4),
      degradation: +degradation.toFixed(3),
      passed: vm.profitFactor >= 1.2 && vm.expectancy > 0,
    });
  }
  const passRate = windows.length ? windows.filter(w => w.passed).length / windows.length : 0;
  return { windows, passRate, latest: windows[windows.length - 1] ?? null };
}

/**
 * Bootstrap resampling: probability that candidate expectancy exceeds the
 * baseline expectancy. Deterministic seed so results are reproducible.
 */
export function bootstrapSuperiority(
  candidate: number[], baseline: number[], iterations = 2000,
): { probability: number; significant: boolean; candidateMean: number; baselineMean: number } {
  const cm = mean(candidate), bm = mean(baseline);
  if (candidate.length < 20 || baseline.length < 20) {
    return { probability: 0, significant: false, candidateMean: cm, baselineMean: bm };
  }
  let seed = 1337;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
  let wins = 0;
  for (let i = 0; i < iterations; i++) {
    let a = 0, b = 0;
    for (let j = 0; j < candidate.length; j++) a += candidate[Math.floor(rnd() * candidate.length)];
    for (let j = 0; j < baseline.length; j++) b += baseline[Math.floor(rnd() * baseline.length)];
    if (a / candidate.length > b / baseline.length) wins++;
  }
  const probability = wins / iterations;
  return { probability, significant: probability >= 0.95, candidateMean: cm, baselineMean: bm };
}

/** Concept-drift detection versus a 300-trade baseline. */
export interface DriftReport {
  detected: boolean;
  reasons: string[];
  zProfitFactor: number;
  winRateDelta: number;
  confidenceDelta: number;
  regimeShift: number;
}

export function detectDrift(all: LcTrade[]): DriftReport {
  const reasons: string[] = [];
  const recent = all.slice(-50);
  const baseline = all.slice(-350, -50);
  if (recent.length < 20 || baseline.length < 50) {
    return { detected: false, reasons: ["insufficient_history"], zProfitFactor: 0, winRateDelta: 0, confidenceDelta: 0, regimeShift: 0 };
  }
  const rm = windowMetrics(recent), bm = windowMetrics(baseline);
  const sd = std(baseline.map(t => t.pnl)) / Math.sqrt(recent.length) || 1e-9;
  const z = (rm.expectancy - bm.expectancy) / sd;
  if (z <= -3) reasons.push("expectancy_3sigma_deterioration");
  const wrDelta = rm.winRate - bm.winRate;
  if (wrDelta <= -0.10) reasons.push("win_rate_drop");
  const confDelta = mean(recent.map(t => t.confidence)) - mean(baseline.map(t => t.confidence));
  if (Math.abs(confDelta) >= 0.10) reasons.push("confidence_distribution_shift");
  if (rm.profitFactor < bm.profitFactor * 0.7) reasons.push("profit_factor_decay");

  const freq = (xs: LcTrade[]) => {
    const map = new Map<string, number>();
    for (const t of xs) map.set(t.regime, (map.get(t.regime) ?? 0) + 1);
    return map;
  };
  const rf = freq(recent), bf = freq(baseline);
  const keys = new Set([...rf.keys(), ...bf.keys()]);
  let shift = 0;
  for (const k of keys) shift += Math.abs((rf.get(k) ?? 0) / recent.length - (bf.get(k) ?? 0) / baseline.length);
  shift /= 2;
  if (shift >= 0.4) reasons.push("regime_frequency_shift");

  return {
    detected: reasons.length > 0,
    reasons,
    zProfitFactor: +z.toFixed(2),
    winRateDelta: +wrDelta.toFixed(3),
    confidenceDelta: +confDelta.toFixed(3),
    regimeShift: +shift.toFixed(3),
  };
}

export interface RegimeStat {
  regime: string; trades: number; wins: number;
  profitFactor: number; winRate: number; expectancy: number;
}

export function regimeBreakdown(all: LcTrade[]): RegimeStat[] {
  const groups = new Map<string, LcTrade[]>();
  for (const t of all) {
    const k = t.regime || "unknown";
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.entries()].map(([regime, xs]) => {
    const m = windowMetrics(xs);
    return {
      regime, trades: m.trades, wins: Math.round(m.winRate * m.trades),
      profitFactor: +m.profitFactor.toFixed(3),
      winRate: +m.winRate.toFixed(3),
      expectancy: +m.expectancy.toFixed(4),
    };
  }).sort((a, b) => b.trades - a.trades);
}

// ---------------------------------------------------------------------------
// Promotion / demotion rule sets
// ---------------------------------------------------------------------------

export interface RuleCheck { label: string; passed: boolean; detail: string; }

export function shadowToPaperChecks(m: WindowMetrics): RuleCheck[] {
  return [
    { label: "≥100 shadow trades", passed: m.trades >= 100, detail: `${m.trades}` },
    { label: "Profit factor ≥1.40", passed: m.profitFactor >= 1.40, detail: m.profitFactor.toFixed(2) },
    { label: "Win rate ≥52%", passed: m.winRate >= 0.52, detail: `${(m.winRate * 100).toFixed(1)}%` },
    { label: "Expectancy >0", passed: m.expectancy > 0, detail: m.expectancy.toFixed(2) },
    { label: "Max drawdown ≤6%", passed: m.maxDrawdown <= 0.06, detail: `${(m.maxDrawdown * 100).toFixed(1)}%` },
    { label: "Sharpe ≥1.0", passed: m.sharpe >= 1.0, detail: m.sharpe.toFixed(2) },
    { label: "Average R ≥1.8", passed: m.avgR >= 1.8, detail: m.avgR.toFixed(2) },
  ];
}

export function paperToLiveChecks(m: WindowMetrics, recent50: WindowMetrics, riskViolations: number): RuleCheck[] {
  return [
    { label: "≥150 paper trades", passed: m.trades >= 150, detail: `${m.trades}` },
    { label: "Profit factor ≥1.60", passed: m.profitFactor >= 1.60, detail: m.profitFactor.toFixed(2) },
    { label: "Win rate ≥55%", passed: m.winRate >= 0.55, detail: `${(m.winRate * 100).toFixed(1)}%` },
    { label: "Sharpe ≥1.3", passed: m.sharpe >= 1.3, detail: m.sharpe.toFixed(2) },
    { label: "Sortino ≥1.5", passed: m.sortino >= 1.5, detail: m.sortino.toFixed(2) },
    { label: "Max drawdown ≤5%", passed: m.maxDrawdown <= 0.05, detail: `${(m.maxDrawdown * 100).toFixed(1)}%` },
    { label: "Recent 50 profitable", passed: recent50.netPnl > 0, detail: recent50.netPnl.toFixed(2) },
    { label: "No risk violations", passed: riskViolations === 0, detail: `${riskViolations}` },
  ];
}

export interface DemotionVerdict { demote: boolean; disable: boolean; reasons: string[]; }

export function liveDemotionCheck(
  last50: WindowMetrics, last100: WindowMetrics, baseline300: WindowMetrics, drift: DriftReport,
): DemotionVerdict {
  const reasons: string[] = [];
  if (last50.trades >= 20) {
    if (last50.profitFactor < 1.20) reasons.push(`profit_factor_${last50.profitFactor.toFixed(2)}_below_1.20`);
    if (last50.winRate < 0.45) reasons.push(`win_rate_${(last50.winRate * 100).toFixed(0)}%_below_45%`);
    if (last50.expectancy <= 0) reasons.push("expectancy_non_positive");
    if (last50.maxDrawdown > 0.08) reasons.push(`drawdown_${(last50.maxDrawdown * 100).toFixed(1)}%_above_8%`);
    if (last50.executionQuality < 0.5) reasons.push("execution_quality_deteriorated");
  }
  if (drift.zProfitFactor <= -3) reasons.push("3_sigma_deterioration_vs_baseline");
  if (last50.consecutiveLosses >= 5) reasons.push("5_consecutive_losses");

  const disableReasons: string[] = [];
  if (last50.consecutiveLosses >= 10) disableReasons.push("10_consecutive_losses");
  if (last100.trades >= 100 && last100.profitFactor < 1.0) disableReasons.push("profit_factor_below_1.0_over_100_trades");

  void baseline300;
  return {
    demote: reasons.length > 0,
    disable: disableReasons.length > 0,
    reasons: disableReasons.length ? disableReasons : reasons,
  };
}
