// Portfolio Manager AI — the institutional layer that sits above every
// strategy and above the Risk Engine. No strategy may execute directly:
// every opportunity is scored, allocated and (possibly) rejected here.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getMacroRegime, regimeFavours, recordRegime, type MacroRegimeReport } from "./regime.server";
import {
  allocationFromScore, computeHealth, correlationVerdict, gradeTrade, modeConstraints,
  overtradingVerdict, proposeCapitalParams, regimeMatrixVerdict, scoreOpportunity,
  sectorVerdict, type CapitalProposal, type HealthReport, type LearnTrade, type ModeConstraints,
  type OpenExposure, type OpportunityScore, type PortfolioMode, type RegimeCell, type StrategyStats,
} from "./scoring";
import { sectorOf, type Sector } from "./sectors";

// ---------------------------------------------------------------------------
// Portfolio context
// ---------------------------------------------------------------------------

export interface PortfolioContext {
  equity: number;
  open: OpenExposure[];
  openCount: number;
  drawdownPct: number;
  health: HealthReport;
  mode: PortfolioMode;
  constraints: ModeConstraints;
  recentOpenTimestamps: number[];
  settings: Record<string, unknown>;
  baseRiskPct: number;
}

const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export async function loadPortfolioContext(
  supabase: SupabaseClient, userId: string, equityOverride?: number,
): Promise<PortfolioContext> {
  const [{ data: settings }, { data: openPos }, { data: closed }, { data: paper }] = await Promise.all([
    supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("positions").select("symbol,side,qty,avg_entry,stop_loss,opened_at,used_margin")
      .eq("user_id", userId).eq("status", "open"),
    supabase.from("positions").select("realized_pnl,closed_at")
      .eq("user_id", userId).eq("status", "closed").order("closed_at", { ascending: false }).limit(300),
    supabase.from("paper_accounts").select("cash_balance,equity").eq("user_id", userId).maybeSingle(),
  ]);

  const s = (settings ?? {}) as Record<string, unknown>;
  const equity = equityOverride && equityOverride > 0
    ? equityOverride
    : num((paper as Record<string, unknown> | null)?.["equity"], 0) || num((paper as Record<string, unknown> | null)?.["cash_balance"], 10_000);

  const open: OpenExposure[] = (openPos ?? []).map(p => {
    const qty = num(p.qty), entry = num(p.avg_entry), stop = num(p.stop_loss, entry);
    const risk = Math.abs(entry - stop) * qty;
    return {
      symbol: p.symbol as string,
      side: (p.side === "short" ? "short" : "long") as "long" | "short",
      riskPct: equity > 0 ? +((risk / equity) * 100).toFixed(4) : 0,
      notional: qty * entry,
    };
  });

  // Realized P&L curve → drawdown + recovery inputs (oldest first).
  const pnls = (closed ?? []).map(c => num(c.realized_pnl)).reverse();
  let peak = 0, cum = 0, maxDd = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
  }
  const realizedPnl = cum;
  const highWater = num(s["equity_high_water"], 0) || Math.max(equity, equity + (peak - cum));
  const drawdownPct = highWater > 0 ? Math.max(0, (highWater - equity) / highWater) : 0;
  const maxDrawdownPct = equity > 0 ? Math.min(1, maxDd / equity) : 0;

  const usedMargin = (openPos ?? []).reduce((sum, p) => sum + num(p.used_margin), 0);
  const recentReturns = pnls.slice(-50).map(p => (equity > 0 ? (p / equity) * 100 : 0));
  const last30 = pnls.slice(-30);
  const last30Profitable = last30.length >= 10 && last30.reduce((a, b) => a + b, 0) > 0;

  const health = computeHealth({
    equity,
    openRiskPct: open.reduce((sum, p) => sum + p.riskPct, 0) / 100,
    usedMarginPct: equity > 0 ? usedMargin / equity : 0,
    open,
    drawdownPct,
    maxDrawdownPct,
    realizedPnl,
    avgVolatilityPct: 0.02,
    recentReturns,
  }, {
    aggressiveEnabled: s["aggressive_mode_enabled"] !== false,
    last30Profitable,
    regimeFavourable: true,
  });

  const constraints = modeConstraints(health.mode, health.healthScore, num(s["pm_min_score"], 75));

  return {
    equity, open, openCount: open.length, drawdownPct, health,
    mode: health.mode, constraints,
    recentOpenTimestamps: (openPos ?? [])
      .map(p => new Date(String(p.opened_at ?? Date.now())).getTime())
      .filter(t => Number.isFinite(t)),
    settings: s,
    baseRiskPct: num(s["risk_per_trade_pct"], 0.5),
  };
}

// ---------------------------------------------------------------------------
// Strategy performance inputs
// ---------------------------------------------------------------------------

export async function loadStrategyStats(
  supabase: SupabaseClient, userId: string, strategyId: string | null,
): Promise<{ stats: StrategyStats; regimeCells: RegimeCell[] }> {
  let q = supabase.from("positions")
    .select("realized_pnl,ai_regime,avg_entry,stop_loss,qty,closed_at")
    .eq("user_id", userId).eq("status", "closed")
    .order("closed_at", { ascending: false }).limit(300);
  if (strategyId) q = q.eq("strategy_id", strategyId);
  const { data } = await q;
  const rows = data ?? [];

  const rows50 = rows.slice(0, 50);
  const winRate = (list: typeof rows) =>
    list.length ? list.filter(r => num(r.realized_pnl) > 0).length / list.length : 0;
  const pnls = rows.map(r => num(r.realized_pnl));
  const rMultiples = rows.map(r => {
    const risk = Math.abs(num(r.avg_entry) - num(r.stop_loss)) * num(r.qty);
    return risk > 0 ? num(r.realized_pnl) / risk : 0;
  });
  const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  const sd = pnls.length > 1
    ? Math.sqrt(pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / (pnls.length - 1)) : 0;
  const grossWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));

  const stats: StrategyStats = {
    winRate50: winRate(rows50),
    winRate300: winRate(rows),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(Math.min(252, Math.max(1, pnls.length)))).toFixed(3) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 2.5 : 1,
    avgRMultiple: rMultiples.length ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : 0,
    expectancy: mean,
    trades: rows.length,
  };

  const byRegime = new Map<string, number[]>();
  for (const r of rows) {
    const k = String(r.ai_regime ?? "unknown");
    byRegime.set(k, [...(byRegime.get(k) ?? []), num(r.realized_pnl)]);
  }
  const regimeCells: RegimeCell[] = [...byRegime.entries()].map(([regime, list]) => {
    const gw = list.filter(p => p > 0).reduce((a, b) => a + b, 0);
    const gl = Math.abs(list.filter(p => p < 0).reduce((a, b) => a + b, 0));
    return {
      regime, trades: list.length,
      winRate: list.filter(p => p > 0).length / list.length,
      profitFactor: gl > 0 ? +(gw / gl).toFixed(3) : gw > 0 ? 3 : 0,
      expectancy: +(list.reduce((a, b) => a + b, 0) / list.length).toFixed(3),
    };
  });

  return { stats, regimeCells };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface OpportunityRequest {
  signalId?: string | null;
  strategyId?: string | null;
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  strategyType?: string | null;
  spreadBps?: number;
  slippageBps?: number;
  liquidityScore?: number;
  newsProximityMinutes?: number;
  fundingRate?: number | null;
  openInterestChangePct?: number | null;
  orderBookImbalance?: number | null;
}

export interface PortfolioVerdict {
  approved: boolean;
  score: number;
  allocation: number;      // 0..1 of the allowed risk budget
  riskPct: number;         // final % of equity to risk
  rejectReason?: string;
  mode: PortfolioMode;
  healthScore: number;
  regime: MacroRegimeReport;
  components: Record<string, number>;
  notes: string[];
  sector: Sector;
}

export async function evaluateOpportunity(
  supabase: SupabaseClient,
  userId: string,
  ctx: PortfolioContext,
  req: OpportunityRequest,
): Promise<PortfolioVerdict> {
  const notes: string[] = [...ctx.health.notes];
  const regime = await getMacroRegime(supabase, req.symbol);
  const { stats, regimeCells } = await loadStrategyStats(supabase, userId, req.strategyId ?? null);
  const risk = Math.abs(req.entry - req.stopLoss);
  const reward = Math.abs(req.takeProfit - req.entry);
  const expectedR = risk > 0 ? reward / risk : 0;
  const sector = sectorOf(req.symbol);

  const reject = (reason: string, score = 0, components: Record<string, number> = {}): PortfolioVerdict => ({
    approved: false, score, allocation: 0, riskPct: 0, rejectReason: reason,
    mode: ctx.mode, healthScore: ctx.health.healthScore, regime, components, notes, sector,
  });

  // --- hard vetoes before scoring -----------------------------------------
  if (!regime.tradable) return reject(`regime_untradable:${regime.regime}`);
  const matrix = regimeMatrixVerdict(regimeCells, regime.regime);
  if (!matrix.allowed) { notes.push("Strategy is historically unprofitable in this regime"); return reject(matrix.reason!); }

  const counterTrend = !regimeFavours(regime, req.side);
  if (ctx.mode === "defensive") {
    if (ctx.openCount >= (ctx.constraints.maxOpenTrades ?? 1)) return reject("defensive_mode:max_one_open_trade");
    if (counterTrend) return reject("defensive_mode:no_counter_trend");
    if ((req.strategyType ?? "").includes("mean_reversion")) return reject("defensive_mode:no_mean_reversion");
    if (req.confidence < ctx.constraints.minConfidence) {
      return reject(`defensive_mode:confidence_${(req.confidence * 100).toFixed(0)}%<95%`);
    }
  }

  // --- score ---------------------------------------------------------------
  const proposedRiskPct = ctx.baseRiskPct;
  const corr = correlationVerdict(req.symbol, req.side, ctx.open, {
    maxCryptoBetaPct: num(ctx.settings["max_crypto_beta"], 6),
    maxCorrelatedRiskPct: num(ctx.settings["max_correlated_risk_pct"], 2),
    newRiskPct: proposedRiskPct,
  });
  notes.push(...corr.notes);
  if (corr.blocked) return reject(`correlation:${corr.reason}`);

  const scored: OpportunityScore = scoreOpportunity({
    symbol: req.symbol, side: req.side,
    aiConfidence: req.confidence,
    expectedR,
    regime: regime.regime,
    regimeConfidence: regime.confidence,
    regimeFavoursSide: !counterTrend,
    trendQuality: regime.trendQuality,
    volatilityPct: regime.volatilityPct,
    accountDrawdownPct: ctx.drawdownPct,
    exposurePct: ctx.open.reduce((s, p) => s + p.riskPct, 0) / 100,
    correlationPenalty: corr.multiplier,
    strategy: stats,
    spreadBps: req.spreadBps ?? 8,
    slippageBps: req.slippageBps ?? 5,
    liquidityScore: req.liquidityScore ?? Math.min(1, regime.volumeRatio),
    hourUtc: new Date().getUTCHours(),
    newsProximityMinutes: req.newsProximityMinutes ?? 240,
    fundingRate: req.fundingRate ?? null,
    openInterestChangePct: req.openInterestChangePct ?? null,
    volumeRatio: regime.volumeRatio,
    orderBookImbalance: req.orderBookImbalance ?? null,
  });
  notes.push(...scored.notes);

  const minScore = ctx.constraints.minScore;
  if (scored.score < minScore) {
    return reject(`score_below_minimum:${scored.score.toFixed(1)}<${minScore}`, scored.score, scored.components);
  }

  // --- overtrading ---------------------------------------------------------
  const ot = overtradingVerdict(ctx.recentOpenTimestamps, Date.now(), scored.score, {
    windowMinutes: num(ctx.settings["overtrading_window_minutes"], 30),
    maxTrades: num(ctx.settings["overtrading_max_trades"], 3),
    minScore: num(ctx.settings["overtrading_min_score"], 95),
  });
  if (!ot.allowed) return reject(ot.reason!, scored.score, scored.components);

  // --- allocation ----------------------------------------------------------
  const ladder = allocationFromScore(scored.score);
  if (ladder === 0) return reject(`allocation_zero:${scored.score.toFixed(1)}`, scored.score, scored.components);
  const allocation = +(ladder * corr.multiplier * ctx.constraints.sizeMultiplier).toFixed(4);
  const riskPct = +(proposedRiskPct * allocation).toFixed(4);
  if (!(riskPct > 0)) return reject("allocation_zero_after_haircuts", scored.score, scored.components);

  // --- sector cap ----------------------------------------------------------
  const addNotionalPct = ctx.equity > 0
    ? ((req.entry * (riskPct / 100 * ctx.equity) / Math.max(risk, 1e-9)) / ctx.equity) * 100 : 0;
  const sec = sectorVerdict(req.symbol, addNotionalPct, ctx.health.sectorExposure,
    (ctx.settings["sector_limits"] ?? {}) as Partial<Record<Sector, number>>);
  if (!sec.allowed) return reject(sec.reason!, scored.score, scored.components);

  notes.push(
    `Allocated ${(allocation * 100).toFixed(0)}% of risk budget (${riskPct.toFixed(3)}% of equity) in ${ctx.mode} mode`,
  );

  return {
    approved: true, score: scored.score, allocation, riskPct,
    mode: ctx.mode, healthScore: ctx.health.healthScore, regime,
    components: scored.components, notes, sector,
  };
}

/** Persist the decision — every scored opportunity, approved or not. */
export async function recordDecision(
  supabase: SupabaseClient, userId: string, req: OpportunityRequest, v: PortfolioVerdict,
): Promise<void> {
  await supabase.from("portfolio_decisions").insert({
    user_id: userId,
    signal_id: req.signalId ?? null,
    strategy_id: req.strategyId ?? null,
    symbol: req.symbol, side: req.side,
    score: v.score, allocation_pct: v.allocation * 100, risk_pct: v.riskPct,
    approved: v.approved, reject_reason: v.rejectReason ?? null,
    portfolio_mode: v.mode, regime: v.regime.regime, health_score: v.healthScore,
    components: { ...v.components, sector: v.sector } as never,
    notes: v.notes as never,
  });
}

export async function snapshotHealth(
  supabase: SupabaseClient, userId: string, ctx: PortfolioContext, regime?: string,
): Promise<void> {
  const h = ctx.health;
  await supabase.from("portfolio_health_snapshots").insert({
    user_id: userId,
    health_score: h.healthScore, heat: h.heat, risk_concentration: h.riskConcentration,
    capital_utilization: h.capitalUtilization, correlation_score: h.correlationScore,
    volatility: h.volatility, expected_drawdown: h.expectedDrawdown,
    diversification_score: h.diversificationScore, recovery_factor: h.recoveryFactor,
    expected_monthly_return: h.expectedMonthlyReturn, worst_case_projection: h.worstCaseProjection,
    portfolio_mode: h.mode, regime: regime ?? null,
    sector_exposure: h.sectorExposure as never,
    detail: { notes: h.notes, openPositions: ctx.openCount, equity: ctx.equity } as never,
  });
  if (ctx.settings["portfolio_mode"] !== h.mode) {
    await supabase.from("automation_settings").update({ portfolio_mode: h.mode }).eq("user_id", userId);
    const { emitNotification } = await import("@/lib/notifications/emit.server");
    await emitNotification(supabase, userId, {
      kind: "portfolio.mode_change",
      severity: h.mode === "defensive" ? "critical" : "info",
      title: `Portfolio mode → ${h.mode}`,
      message: `Health score ${h.healthScore}. ${h.notes[0] ?? ""}`,
    }).catch(() => undefined);
  }
}

export { recordRegime };

// ---------------------------------------------------------------------------
// Trade quality grading for closed trades
// ---------------------------------------------------------------------------

export async function gradeClosedTrades(
  supabase: SupabaseClient, userId: string, limit = 50,
): Promise<{ graded: number }> {
  const { data: rows } = await supabase.from("positions")
    .select("id,symbol,side,qty,avg_entry,stop_loss,take_profit,exit_price,exit_reason,ai_confidence,duration_seconds,strategy_id,commission,swap,closed_at")
    .eq("user_id", userId).eq("status", "closed")
    .order("closed_at", { ascending: false }).limit(limit);
  if (!rows?.length) return { graded: 0 };

  const { data: existing } = await supabase.from("trade_quality_scores")
    .select("position_id").eq("user_id", userId)
    .in("position_id", rows.map(r => r.id));
  const done = new Set((existing ?? []).map(e => e.position_id));

  let graded = 0;
  for (const r of rows) {
    if (done.has(r.id)) continue;
    const entry = num(r.avg_entry);
    const report = gradeTrade({
      plannedEntry: entry, actualEntry: entry,
      plannedStop: num(r.stop_loss, entry * 0.99),
      plannedTarget: num(r.take_profit, entry * 1.02),
      exitPrice: num(r.exit_price, entry),
      side: r.side === "short" ? "short" : "long",
      slippageBps: 4, latencyMs: 400,
      holdingMinutes: num(r.duration_seconds) / 60,
      plannedHoldingMinutes: 240,
      riskPct: 1, plannedRiskPct: 1,
      aiConfidence: num(r.ai_confidence, 0.8),
      exitReason: String(r.exit_reason ?? "unknown"),
      manualInterventions: 0,
    });
    await supabase.from("trade_quality_scores").insert({
      user_id: userId, position_id: r.id, strategy_id: r.strategy_id, symbol: r.symbol,
      execution_quality: report.executionQuality, entry_timing: report.entryTiming,
      exit_timing: report.exitTiming, risk_quality: report.riskQuality,
      size_quality: report.sizeQuality, psychology: report.psychology,
      ai_confidence: report.aiConfidence, overall: report.overall, grade: report.grade,
      detail: { notes: report.notes, exitReason: r.exit_reason } as never,
    });
    graded++;
  }
  return { graded };
}

// ---------------------------------------------------------------------------
// Self-learning capital engine — every 100 closed trades
// ---------------------------------------------------------------------------

export async function runCapitalEngine(
  supabase: SupabaseClient, userId: string,
): Promise<{ ran: boolean; version?: number; proposal?: CapitalProposal }> {
  const { count } = await supabase.from("positions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("status", "closed");
  const closedCount = count ?? 0;
  if (closedCount < 100) return { ran: false };

  const { data: last } = await supabase.from("capital_engine_params")
    .select("version,trades_evaluated").eq("user_id", userId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (last && closedCount - num(last.trades_evaluated) < 100) return { ran: false };

  const { data: rows } = await supabase.from("positions")
    .select("realized_pnl,avg_entry,stop_loss,take_profit,qty,duration_seconds,trailing_stop_pct,strategy_id,exit_reason")
    .eq("user_id", userId).eq("status", "closed")
    .order("closed_at", { ascending: false }).limit(300);

  const trades: LearnTrade[] = (rows ?? []).map(r => {
    const entry = num(r.avg_entry), stop = num(r.stop_loss, entry), tp = num(r.take_profit, entry);
    const risk = Math.abs(entry - stop) * num(r.qty);
    return {
      pnl: num(r.realized_pnl),
      rMultiple: risk > 0 ? num(r.realized_pnl) / risk : 0,
      riskPct: 1,
      stopAtrMult: entry > 0 ? Math.abs(entry - stop) / (entry * 0.01) : 1.5,
      tpRMultiple: Math.abs(entry - stop) > 0 ? Math.abs(tp - entry) / Math.abs(entry - stop) : 2,
      holdingMinutes: num(r.duration_seconds) / 60,
      trailingPct: num(r.trailing_stop_pct, 0.015),
      strategyId: (r.strategy_id as string | null) ?? null,
      exitReason: String(r.exit_reason ?? "unknown"),
    };
  });

  const proposal = proposeCapitalParams(trades);
  const version = num(last?.version, 0) + 1;
  // Proposals never touch live behaviour — they are validated in shadow first.
  await supabase.from("capital_engine_params").insert({
    user_id: userId, version, status: "shadow", trades_evaluated: closedCount,
    optimal_allocation_pct: proposal.optimalAllocationPct,
    optimal_stop_atr_mult: proposal.optimalStopAtrMult,
    optimal_tp_r_multiple: proposal.optimalTpRMultiple,
    optimal_holding_minutes: proposal.optimalHoldingMinutes,
    optimal_trailing_pct: proposal.optimalTrailingPct,
    strategy_weights: proposal.strategyWeights as never,
    metrics: proposal.metrics as never,
  });
  return { ran: true, version, proposal };
}
