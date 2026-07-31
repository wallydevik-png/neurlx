// Portfolio Intelligence — pure scoring maths.
// Every function here is deterministic and IO-free so it can be unit tested
// and reused by the autopilot, the dashboard and the shadow simulator.
import {
  DEFAULT_SECTOR_LIMITS, assumedCorrelation, baseAsset, isCrypto,
  sectorOf, type Sector,
} from "./sectors";

export type PortfolioMode = "normal" | "defensive" | "aggressive";

export type MacroRegime =
  | "strong_bull" | "bull" | "range" | "high_volatility"
  | "bear" | "panic" | "low_liquidity";

export const REGIME_LABELS: Record<MacroRegime, string> = {
  strong_bull: "Strong bull",
  bull: "Bull",
  range: "Range",
  high_volatility: "High volatility",
  bear: "Bear",
  panic: "Panic",
  low_liquidity: "Low liquidity",
};

// ---------------------------------------------------------------------------
// Opportunity scoring (0-100)
// ---------------------------------------------------------------------------

export interface StrategyStats {
  winRate50: number;      // 0..1
  winRate300: number;     // 0..1
  sharpe: number;
  profitFactor: number;
  avgRMultiple: number;
  expectancy: number;     // currency per trade
  trades: number;
}

export interface OpportunityInput {
  symbol: string;
  side: "buy" | "sell";
  aiConfidence: number;          // 0..1
  expectedR: number;             // reward : risk of the proposed frame
  regime: MacroRegime;
  regimeConfidence: number;      // 0..1
  regimeFavoursSide: boolean;
  trendQuality: number;          // 0..1 (ADX / structure quality)
  volatilityPct: number;         // ATR / price
  accountDrawdownPct: number;    // 0..1 from high-water mark
  exposurePct: number;           // 0..1 of equity already at risk
  correlationPenalty: number;    // 0..1 (1 = no correlated exposure)
  strategy: StrategyStats;
  spreadBps: number;
  slippageBps: number;
  liquidityScore: number;        // 0..1
  hourUtc: number;
  newsProximityMinutes: number;  // minutes to nearest high-impact event
  fundingRate?: number | null;   // crypto, per 8h (e.g. 0.0001)
  openInterestChangePct?: number | null;
  volumeRatio?: number | null;   // current vs 20-bar average
  orderBookImbalance?: number | null; // -1..1, positive = bid heavy
}

export interface OpportunityScore {
  score: number;
  components: Record<string, number>;
  notes: string[];
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const pct = (v: number) => Math.round(clamp01(v) * 100);

/** Liquidity-hostile UTC hours (thin books, rollover). */
function sessionQuality(hourUtc: number): number {
  if (hourUtc >= 12 && hourUtc < 17) return 1;      // London/NY overlap
  if (hourUtc >= 7 && hourUtc < 12) return 0.85;    // London
  if (hourUtc >= 17 && hourUtc < 21) return 0.8;    // NY afternoon
  if (hourUtc >= 0 && hourUtc < 5) return 0.55;     // Asia
  if (hourUtc === 21 || hourUtc === 22) return 0.35; // rollover
  return 0.6;
}

const WEIGHTS: Record<string, number> = {
  expectedReturn: 10,
  expectancy: 7,
  volatility: 6,
  drawdown: 6,
  exposure: 6,
  correlation: 9,
  trendQuality: 7,
  regime: 9,
  aiConfidence: 10,
  strategyRecent: 6,
  winRate50: 4,
  winRate300: 4,
  sharpe: 5,
  profitFactor: 5,
  avgR: 4,
  cost: 5,
  liquidity: 4,
  session: 3,
  news: 4,
  flow: 6, // funding + OI + volume + order book
};

export function scoreOpportunity(i: OpportunityInput): OpportunityScore {
  const notes: string[] = [];
  const s = i.strategy;

  const c: Record<string, number> = {
    // Expected return: 2R is par, 4R+ is excellent.
    expectedReturn: clamp01((i.expectedR - 1) / 3),
    expectancy: clamp01(s.expectancy > 0 ? 0.5 + Math.min(0.5, s.expectancy / 200) : s.expectancy / 200 + 0.5),
    // Volatility: 1.5%-3% ATR is the sweet spot; dead or wild markets score low.
    volatility: i.volatilityPct <= 0.002 ? 0.15
      : i.volatilityPct < 0.015 ? 0.6 + (i.volatilityPct - 0.002) / 0.013 * 0.35
      : i.volatilityPct <= 0.03 ? 1
      : clamp01(1 - (i.volatilityPct - 0.03) / 0.04),
    drawdown: clamp01(1 - i.accountDrawdownPct / 0.15),
    exposure: clamp01(1 - i.exposurePct / 0.06),
    correlation: clamp01(i.correlationPenalty),
    trendQuality: clamp01(i.trendQuality),
    regime: clamp01((i.regimeFavoursSide ? 0.6 : 0.15) + i.regimeConfidence * 0.4),
    aiConfidence: clamp01((i.aiConfidence - 0.5) / 0.5),
    strategyRecent: clamp01(s.trades === 0 ? 0.5 : (s.winRate50 - 0.3) / 0.4),
    winRate50: clamp01((s.winRate50 - 0.3) / 0.4),
    winRate300: clamp01((s.winRate300 - 0.3) / 0.4),
    sharpe: clamp01(s.sharpe / 2.5),
    profitFactor: clamp01((s.profitFactor - 0.8) / 1.4),
    avgR: clamp01((s.avgRMultiple + 0.5) / 2),
    cost: clamp01(1 - (i.spreadBps + i.slippageBps) / 40),
    liquidity: clamp01(i.liquidityScore),
    session: sessionQuality(i.hourUtc),
    news: i.newsProximityMinutes >= 120 ? 1 : clamp01(i.newsProximityMinutes / 120),
    flow: flowScore(i),
  };

  let total = 0, weightSum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    total += (c[k] ?? 0.5) * w;
    weightSum += w;
  }
  const score = Math.round((total / weightSum) * 1000) / 10;

  if (c.correlation < 0.5) notes.push("Heavy correlated exposure already open");
  if (c.news < 0.5) notes.push("High-impact news window nearby");
  if (c.cost < 0.5) notes.push("Spread + slippage eating the edge");
  if (c.regime < 0.5) notes.push("Regime does not favour this direction");
  if (c.drawdown < 0.6) notes.push("Account is in drawdown — quality bar raised");
  if (s.trades < 30) notes.push("Thin strategy sample — score damped");

  const components: Record<string, number> = {};
  for (const k of Object.keys(WEIGHTS)) components[k] = pct(c[k] ?? 0.5);

  return { score, components, notes };
}

function flowScore(i: OpportunityInput): number {
  const parts: number[] = [];
  if (i.fundingRate != null && isCrypto(i.symbol)) {
    // Crowded funding against the trade is bad; neutral/negative funding for a
    // long is good.
    const f = i.side === "buy" ? -i.fundingRate : i.fundingRate;
    parts.push(clamp01(0.5 + f * 2000));
  }
  if (i.openInterestChangePct != null) {
    const oi = i.side === "buy" ? i.openInterestChangePct : -i.openInterestChangePct;
    parts.push(clamp01(0.5 + oi * 5));
  }
  if (i.volumeRatio != null) parts.push(clamp01((i.volumeRatio - 0.5) / 1.5));
  if (i.orderBookImbalance != null) {
    const ob = i.side === "buy" ? i.orderBookImbalance : -i.orderBookImbalance;
    parts.push(clamp01(0.5 + ob / 2));
  }
  if (parts.length === 0) return 0.6; // neutral when data unavailable
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

// ---------------------------------------------------------------------------
// Capital allocation ladder
// ---------------------------------------------------------------------------

/** Share of the allowed risk budget granted to a score. 0 → reject. */
export function allocationFromScore(score: number): number {
  if (score >= 95) return 1;
  if (score >= 90) return 0.8;
  if (score >= 85) return 0.6;
  if (score >= 80) return 0.4;
  if (score >= 75) return 0.2;
  return 0;
}

// ---------------------------------------------------------------------------
// Correlation engine
// ---------------------------------------------------------------------------

export interface OpenExposure {
  symbol: string;
  side: "long" | "short";
  riskPct: number;   // % of equity at risk on this position
  notional: number;
}

export interface CorrelationVerdict {
  multiplier: number;        // 0..1 applied to the allocation
  worstRho: number;
  cryptoBeta: number;        // summed correlated crypto risk %
  blocked: boolean;
  reason?: string;
  notes: string[];
}

/**
 * Correlation haircut. Each correlated open position cuts the new allocation
 * proportionally to rho (rho 0.9 → −70%, rho 0.85 → −50%, broad beta → −25%).
 * Opposite-direction exposure on a correlated pair is treated as a hedge and
 * halves the penalty.
 */
export function correlationVerdict(
  symbol: string,
  side: "buy" | "sell",
  open: OpenExposure[],
  opts: { maxCryptoBetaPct?: number; maxCorrelatedRiskPct?: number; newRiskPct?: number } = {},
): CorrelationVerdict {
  const maxBeta = opts.maxCryptoBetaPct ?? 6;
  const maxCorrelated = opts.maxCorrelatedRiskPct ?? 2;
  const newRisk = opts.newRiskPct ?? 0;
  const dir = side === "buy" ? "long" : "short";
  const notes: string[] = [];
  let multiplier = 1;
  let worstRho = 0;
  let correlatedRisk = 0;
  let cryptoBeta = 0;

  for (const p of open) {
    const rho = assumedCorrelation(symbol, p.symbol);
    if (isCrypto(p.symbol) && isCrypto(symbol)) cryptoBeta += p.riskPct * Math.max(rho, 0.4);
    if (rho < 0.5) continue;
    worstRho = Math.max(worstRho, rho);
    const hedge = p.side !== dir;
    const severity = rho >= 0.9 ? 0.7 : rho >= 0.85 ? 0.5 : rho >= 0.75 ? 0.4 : 0.25;
    const cut = hedge ? severity / 2 : severity;
    multiplier *= 1 - cut;
    if (!hedge) correlatedRisk += p.riskPct * rho;
    notes.push(
      `${baseAsset(p.symbol)} open (rho ${rho.toFixed(2)}) → allocation ${hedge ? "reduced" : "cut"} ${Math.round(cut * 100)}%`,
    );
    if (baseAsset(p.symbol) === baseAsset(symbol)) {
      return { multiplier: 0, worstRho: 1, cryptoBeta, blocked: true, reason: "duplicate_exposure", notes };
    }
  }

  if (isCrypto(symbol)) cryptoBeta += newRisk;
  if (correlatedRisk + newRisk > maxCorrelated) {
    return {
      multiplier: 0, worstRho, cryptoBeta, blocked: true,
      reason: `correlated_risk_cap:${(correlatedRisk + newRisk).toFixed(2)}%>${maxCorrelated}%`, notes,
    };
  }
  if (isCrypto(symbol) && cryptoBeta > maxBeta) {
    return {
      multiplier: 0, worstRho, cryptoBeta, blocked: true,
      reason: `crypto_beta_cap:${cryptoBeta.toFixed(2)}%>${maxBeta}%`, notes,
    };
  }

  return { multiplier: +multiplier.toFixed(4), worstRho, cryptoBeta, blocked: false, notes };
}

// ---------------------------------------------------------------------------
// Sector exposure limits
// ---------------------------------------------------------------------------

export interface SectorVerdict {
  sector: Sector;
  currentPct: number;
  limitPct: number;
  allowed: boolean;
  reason?: string;
}

export function sectorExposure(open: OpenExposure[], equity: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (equity <= 0) return out;
  for (const p of open) {
    const k = sectorOf(p.symbol);
    out[k] = (out[k] ?? 0) + (p.notional / equity) * 100;
  }
  for (const k of Object.keys(out)) out[k] = +out[k].toFixed(2);
  return out;
}

export function sectorVerdict(
  symbol: string,
  addPct: number,
  exposure: Record<string, number>,
  limits: Partial<Record<Sector, number>> = {},
): SectorVerdict {
  const sector = sectorOf(symbol);
  const limitPct = limits[sector] ?? DEFAULT_SECTOR_LIMITS[sector];
  const currentPct = exposure[sector] ?? 0;
  const allowed = currentPct + addPct <= limitPct;
  return {
    sector, currentPct: +currentPct.toFixed(2), limitPct, allowed,
    reason: allowed ? undefined : `sector_cap:${sector}:${(currentPct + addPct).toFixed(1)}%>${limitPct}%`,
  };
}

// ---------------------------------------------------------------------------
// Portfolio health
// ---------------------------------------------------------------------------

export interface HealthInput {
  equity: number;
  openRiskPct: number;         // total % of equity at risk
  usedMarginPct: number;       // 0..1
  open: OpenExposure[];
  drawdownPct: number;         // 0..1
  maxDrawdownPct: number;      // 0..1 worst historical
  realizedPnl: number;
  avgVolatilityPct: number;
  recentReturns: number[];     // per-trade returns, newest last
}

export interface HealthReport {
  heat: number;
  riskConcentration: number;
  capitalUtilization: number;
  correlationScore: number;
  volatility: number;
  expectedDrawdown: number;
  diversificationScore: number;
  recoveryFactor: number;
  healthScore: number;
  mode: PortfolioMode;
  expectedMonthlyReturn: number;
  worstCaseProjection: number;
  sectorExposure: Record<string, number>;
  notes: string[];
}

export function computeHealth(i: HealthInput, opts: { aggressiveEnabled?: boolean; last30Profitable?: boolean; regimeFavourable?: boolean } = {}): HealthReport {
  const notes: string[] = [];
  const n = i.open.length;

  const heat = +Math.min(100, i.openRiskPct * 100 / 6).toFixed(1); // 6% risk = 100 heat
  const largest = i.open.reduce((m, p) => Math.max(m, p.riskPct), 0);
  const totalRisk = i.open.reduce((s, p) => s + p.riskPct, 0);
  const riskConcentration = +(totalRisk > 0 ? (largest / totalRisk) * 100 : 0).toFixed(1);
  const capitalUtilization = +Math.min(100, i.usedMarginPct * 100).toFixed(1);

  // Average pairwise correlation of the book (0 = perfectly diversified).
  let pairs = 0, rhoSum = 0;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      rhoSum += assumedCorrelation(i.open[a].symbol, i.open[b].symbol);
      pairs++;
    }
  }
  const avgRho = pairs > 0 ? rhoSum / pairs : 0;
  const correlationScore = +((1 - avgRho) * 100).toFixed(1);

  const sectors = new Set(i.open.map(p => sectorOf(p.symbol)));
  const diversificationScore = +Math.min(100, (sectors.size / 4) * 60 + (1 - avgRho) * 40).toFixed(1);

  const volatility = +Math.min(100, (i.avgVolatilityPct / 0.05) * 100).toFixed(1);
  // Expected drawdown ≈ open risk × correlation clustering, floored by history.
  const expectedDrawdown = +Math.max(
    i.openRiskPct * 100 * (0.6 + avgRho * 0.8),
    i.maxDrawdownPct * 100 * 0.5,
  ).toFixed(2);
  const recoveryFactor = +(i.maxDrawdownPct > 0 && i.equity > 0
    ? i.realizedPnl / (i.maxDrawdownPct * i.equity) : i.realizedPnl > 0 ? 3 : 0).toFixed(2);

  const sub = {
    heat: 100 - heat,
    concentration: 100 - Math.max(0, riskConcentration - 40) * 1.6,
    utilization: 100 - Math.max(0, capitalUtilization - 50) * 2,
    correlation: correlationScore,
    volatility: 100 - volatility,
    drawdown: 100 - Math.min(100, (i.drawdownPct / 0.15) * 100),
    diversification: diversificationScore,
    recovery: Math.min(100, Math.max(0, recoveryFactor * 25 + 25)),
  };
  const healthScore = +Math.max(0, Math.min(100,
    sub.heat * 0.15 + sub.concentration * 0.1 + sub.utilization * 0.1 +
    sub.correlation * 0.15 + sub.volatility * 0.1 + sub.drawdown * 0.2 +
    sub.diversification * 0.1 + sub.recovery * 0.1,
  )).toFixed(1);

  const wins = i.recentReturns.filter(r => r > 0);
  const expectancy = i.recentReturns.length
    ? i.recentReturns.reduce((a, b) => a + b, 0) / i.recentReturns.length : 0;
  const expectedMonthlyReturn = +(expectancy * Math.min(60, i.recentReturns.length || 20)).toFixed(2);
  const worstCaseProjection = +(-(expectedDrawdown + i.openRiskPct * 100)).toFixed(2);

  let mode: PortfolioMode = "normal";
  if (healthScore < 50) { mode = "defensive"; notes.push("Health below 50 — defensive mode engaged"); }
  else if (healthScore < 70) notes.push("Health below 70 — position sizes reduced");
  else if (
    opts.aggressiveEnabled !== false && healthScore > 95 && i.drawdownPct < 0.02 &&
    opts.last30Profitable && opts.regimeFavourable
  ) { mode = "aggressive"; notes.push("Health above 95 with clean drawdown — aggressive mode"); }

  if (wins.length === 0 && i.recentReturns.length >= 10) notes.push("No winners in the recent sample");

  return {
    heat, riskConcentration, capitalUtilization, correlationScore, volatility,
    expectedDrawdown, diversificationScore, recoveryFactor, healthScore, mode,
    expectedMonthlyReturn, worstCaseProjection,
    sectorExposure: sectorExposure(i.open, i.equity), notes,
  };
}

/** Size multiplier implied by the health score / mode. */
export function healthSizeMultiplier(healthScore: number, mode: PortfolioMode): number {
  if (mode === "defensive") return 0.25;                 // cut risk by 75%
  if (mode === "aggressive") return 1.25;
  if (healthScore < 70) return 0.5 + (healthScore - 50) / 40; // 0.5 → 1.0
  return 1;
}

export interface ModeConstraints {
  minScore: number;
  minConfidence: number;
  maxOpenTrades: number | null;
  allowCounterTrend: boolean;
  allowMeanReversion: boolean;
  sizeMultiplier: number;
}

export function modeConstraints(mode: PortfolioMode, healthScore: number, baseMinScore = 75): ModeConstraints {
  if (mode === "defensive") {
    return {
      minScore: Math.max(baseMinScore, 90), minConfidence: 0.95, maxOpenTrades: 1,
      allowCounterTrend: false, allowMeanReversion: false,
      sizeMultiplier: healthSizeMultiplier(healthScore, mode),
    };
  }
  if (mode === "aggressive") {
    return {
      minScore: baseMinScore, minConfidence: 0.85, maxOpenTrades: null,
      allowCounterTrend: true, allowMeanReversion: true,
      sizeMultiplier: healthSizeMultiplier(healthScore, mode),
    };
  }
  return {
    minScore: baseMinScore, minConfidence: 0.9, maxOpenTrades: null,
    allowCounterTrend: true, allowMeanReversion: true,
    sizeMultiplier: healthSizeMultiplier(healthScore, mode),
  };
}

// ---------------------------------------------------------------------------
// Regime performance matrix
// ---------------------------------------------------------------------------

export interface RegimeCell {
  regime: string;
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
}

export interface RegimeMatrixVerdict { allowed: boolean; reason?: string; cell: RegimeCell | null; }

/**
 * A strategy that historically loses money in the current regime is silenced.
 * Needs a meaningful sample (>= 10 trades) before it can veto.
 */
export function regimeMatrixVerdict(cells: RegimeCell[], regime: string): RegimeMatrixVerdict {
  const cell = cells.find(c => c.regime === regime) ?? null;
  if (!cell || cell.trades < 10) return { allowed: true, cell };
  if (cell.expectancy < 0 || cell.profitFactor < 1) {
    return {
      allowed: false, cell,
      reason: `regime_matrix:${regime}:pf${cell.profitFactor.toFixed(2)}:exp${cell.expectancy.toFixed(2)}`,
    };
  }
  return { allowed: true, cell };
}

// ---------------------------------------------------------------------------
// Overtrading guard
// ---------------------------------------------------------------------------

export function overtradingVerdict(
  recentOpenTimestamps: number[],
  now: number,
  score: number,
  opts: { windowMinutes?: number; maxTrades?: number; minScore?: number } = {},
): { allowed: boolean; reason?: string; countInWindow: number } {
  const windowMs = (opts.windowMinutes ?? 30) * 60_000;
  const max = opts.maxTrades ?? 3;
  const minScore = opts.minScore ?? 95;
  const countInWindow = recentOpenTimestamps.filter(t => now - t <= windowMs).length;
  if (countInWindow >= max && score < minScore) {
    return {
      allowed: false, countInWindow,
      reason: `overtrading:${countInWindow}_in_${opts.windowMinutes ?? 30}m_score_${score.toFixed(1)}<${minScore}`,
    };
  }
  return { allowed: true, countInWindow };
}

// ---------------------------------------------------------------------------
// Trade quality scoring
// ---------------------------------------------------------------------------

export interface TradeQualityInput {
  plannedEntry: number;
  actualEntry: number;
  plannedStop: number;
  plannedTarget: number;
  exitPrice: number;
  side: "long" | "short";
  slippageBps: number;
  latencyMs: number;
  holdingMinutes: number;
  plannedHoldingMinutes: number;
  riskPct: number;
  plannedRiskPct: number;
  aiConfidence: number;
  exitReason: string;
  manualInterventions: number;
  maxFavourableExcursionR?: number | null;
  maxAdverseExcursionR?: number | null;
}

export type TradeGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export interface TradeQualityReport {
  executionQuality: number;
  entryTiming: number;
  exitTiming: number;
  riskQuality: number;
  sizeQuality: number;
  psychology: number;
  aiConfidence: number;
  overall: number;
  grade: TradeGrade;
  notes: string[];
}

export function gradeTrade(i: TradeQualityInput): TradeQualityReport {
  const notes: string[] = [];
  const dir = i.side === "long" ? 1 : -1;
  const risk = Math.abs(i.plannedEntry - i.plannedStop) || 1;

  const executionQuality = pct(1 - Math.min(1, i.slippageBps / 25) * 0.7 - Math.min(1, i.latencyMs / 3000) * 0.3);
  const entrySlip = ((i.actualEntry - i.plannedEntry) * dir) / risk;
  const entryTiming = pct(1 - Math.min(1, Math.max(0, entrySlip) / 0.5));
  const capturedR = ((i.exitPrice - i.actualEntry) * dir) / risk;
  const mfe = i.maxFavourableExcursionR ?? Math.max(capturedR, 0);
  const exitTiming = pct(mfe > 0 ? Math.min(1, Math.max(0, capturedR) / mfe) : capturedR >= 0 ? 0.7 : 0.35);
  const mae = i.maxAdverseExcursionR ?? 0;
  const riskQuality = pct(1 - Math.min(1, Math.max(0, mae) / 1.2) * 0.6 - (i.exitReason === "stop_loss" ? 0.15 : 0));
  const sizeQuality = pct(1 - Math.min(1, Math.abs(i.riskPct - i.plannedRiskPct) / Math.max(0.001, i.plannedRiskPct)));
  const holdRatio = i.plannedHoldingMinutes > 0 ? i.holdingMinutes / i.plannedHoldingMinutes : 1;
  const psychology = pct(
    1 - Math.min(0.5, i.manualInterventions * 0.2) - Math.min(0.3, Math.abs(Math.log(Math.max(0.05, holdRatio))) / 4),
  );
  const conf = pct(i.aiConfidence);

  const overall = Math.round(
    executionQuality * 0.2 + entryTiming * 0.15 + exitTiming * 0.2 + riskQuality * 0.2 +
    sizeQuality * 0.1 + psychology * 0.1 + conf * 0.05,
  );

  const grade: TradeGrade =
    overall >= 93 ? "A+" : overall >= 85 ? "A" : overall >= 75 ? "B"
    : overall >= 65 ? "C" : overall >= 50 ? "D" : "F";

  if (executionQuality < 60) notes.push("Poor fill quality — slippage or latency");
  if (exitTiming < 60) notes.push("Left profit on the table");
  if (sizeQuality < 60) notes.push("Position size drifted from plan");
  if (i.manualInterventions > 0) notes.push(`${i.manualInterventions} manual intervention(s)`);

  return {
    executionQuality, entryTiming, exitTiming, riskQuality, sizeQuality,
    psychology, aiConfidence: conf, overall, grade, notes,
  };
}

// ---------------------------------------------------------------------------
// Self-learning capital engine
// ---------------------------------------------------------------------------

export interface LearnTrade {
  pnl: number;
  rMultiple: number;
  riskPct: number;
  stopAtrMult: number;
  tpRMultiple: number;
  holdingMinutes: number;
  trailingPct: number;
  strategyId: string | null;
  exitReason: string;
}

export interface CapitalProposal {
  optimalAllocationPct: number;
  optimalStopAtrMult: number;
  optimalTpRMultiple: number;
  optimalHoldingMinutes: number;
  optimalTrailingPct: number;
  strategyWeights: Record<string, number>;
  metrics: Record<string, number>;
  notes: string[];
}

function bestBucket(trades: LearnTrade[], key: (t: LearnTrade) => number, buckets: number[]): number {
  let best = buckets[Math.floor(buckets.length / 2)];
  let bestExp = -Infinity;
  for (let b = 0; b < buckets.length; b++) {
    const lo = b === 0 ? -Infinity : (buckets[b - 1] + buckets[b]) / 2;
    const hi = b === buckets.length - 1 ? Infinity : (buckets[b] + buckets[b + 1]) / 2;
    const inB = trades.filter(t => key(t) > lo && key(t) <= hi);
    if (inB.length < 5) continue;
    const exp = inB.reduce((s, t) => s + t.rMultiple, 0) / inB.length;
    if (exp > bestExp) { bestExp = exp; best = buckets[b]; }
  }
  return best;
}

export function proposeCapitalParams(trades: LearnTrade[]): CapitalProposal {
  const notes: string[] = [];
  const rs = trades.map(t => t.rMultiple);
  const expectancy = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  const wins = trades.filter(t => t.pnl > 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 3 : 0;

  // Kelly-lite allocation, capped hard for capital preservation.
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = trades.length - wins.length ? grossLoss / (trades.length - wins.length) : 1;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly = payoff > 0 ? winRate - (1 - winRate) / payoff : 0;
  const optimalAllocationPct = +Math.min(1, Math.max(0.25, kelly * 100 * 0.25)).toFixed(3);
  if (kelly <= 0) notes.push("Negative Kelly — allocation floored at 0.25%");

  const optimalStopAtrMult = +bestBucket(trades, t => t.stopAtrMult, [1, 1.5, 2, 2.5, 3]).toFixed(2);
  const optimalTpRMultiple = +bestBucket(trades, t => t.tpRMultiple, [1.5, 2, 2.5, 3, 4]).toFixed(2);
  const optimalHoldingMinutes = Math.round(bestBucket(trades, t => t.holdingMinutes, [60, 240, 720, 1440, 4320]));
  const optimalTrailingPct = +bestBucket(trades, t => t.trailingPct, [0.005, 0.01, 0.015, 0.02, 0.03]).toFixed(4);

  const byStrategy = new Map<string, LearnTrade[]>();
  for (const t of trades) {
    const k = t.strategyId ?? "unassigned";
    byStrategy.set(k, [...(byStrategy.get(k) ?? []), t]);
  }
  const raw: Record<string, number> = {};
  for (const [k, list] of byStrategy) {
    const exp = list.reduce((s, t) => s + t.rMultiple, 0) / list.length;
    raw[k] = Math.max(0.1, 1 + exp); // expectancy-tilted weight
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0) || 1;
  const strategyWeights: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) strategyWeights[k] = +(v / sum).toFixed(4);

  return {
    optimalAllocationPct, optimalStopAtrMult, optimalTpRMultiple,
    optimalHoldingMinutes, optimalTrailingPct, strategyWeights,
    metrics: {
      trades: trades.length,
      expectancyR: +expectancy.toFixed(3),
      winRate: +winRate.toFixed(3),
      profitFactor: +profitFactor.toFixed(3),
      kelly: +kelly.toFixed(3),
    },
    notes,
  };
}
