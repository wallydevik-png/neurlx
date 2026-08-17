// Strategy lifecycle engine — shadow → paper → live promotion, live
// monitoring, demotion, drift detection, capital allocation and retraining.
// Server-only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitNotification } from "@/lib/notifications/emit.server";
import {
  allocationForScore, bootstrapSuperiority, detectDrift, liveDemotionCheck,
  paperToLiveChecks, regimeBreakdown, shadowToPaperChecks, strategyScore,
  walkForward, windowMetrics, EMPTY_METRICS,
  type LcTrade, type LifecycleState, type RuleCheck, type WindowMetrics,
} from "./metrics";

export const MIN_LIVE_SCORE = 80;

type Row = Record<string, unknown>;

function num(v: unknown, d = 0): number {
  const n = Number(v); return Number.isFinite(n) ? n : d;
}

function shadowRowToTrade(r: Row): LcTrade | null {
  if (r.status !== "closed" || r.close_ts == null) return null;
  const entry = num(r.entry_price), stop = num(r.stop_loss), close = num(r.close_price);
  const risk = Math.abs(entry - stop) * num(r.qty, 1);
  const pnl = num(r.pnl);
  return {
    ts: new Date(String(r.close_ts)).getTime(),
    pnl,
    rMultiple: r.r_multiple != null ? num(r.r_multiple) : (risk > 0 ? pnl / risk : 0),
    regime: String(r.market_regime ?? "unknown"),
    slippage: num(r.slippage),
    spread: num(r.spread),
    latencyMs: num(r.latency_ms),
    confidence: num(r.confidence),
    holdingMs: Math.max(0, new Date(String(r.close_ts)).getTime() - new Date(String(r.entry_ts)).getTime()),
    ...(close ? {} : {}),
  };
}

function positionRowToTrade(r: Row): LcTrade | null {
  if (r.status !== "closed" || r.closed_at == null) return null;
  const entry = num(r.avg_entry), stop = num(r.stop_loss), qty = num(r.qty, 1);
  const risk = Math.abs(entry - stop) * qty;
  const pnl = num(r.realized_pnl);
  return {
    ts: new Date(String(r.closed_at)).getTime(),
    pnl,
    rMultiple: risk > 0 ? pnl / risk : 0,
    regime: String(r.ai_regime ?? "unknown"),
    slippage: 0,
    spread: 0,
    latencyMs: 0,
    confidence: num(r.ai_confidence),
    holdingMs: num(r.duration_seconds) * 1000,
  };
}

/** Load the trade stream a strategy is judged on for its current state. */
export async function loadStrategyTrades(
  supabase: SupabaseClient, userId: string, strategyId: string,
): Promise<{ shadow: LcTrade[]; paper: LcTrade[]; live: LcTrade[] }> {
  const [{ data: shadowRows }, { data: posRows }] = await Promise.all([
    supabase.from("shadow_trades").select("*")
      .eq("user_id", userId).eq("strategy_id", strategyId)
      .order("entry_ts", { ascending: true }).limit(1000),
    supabase.from("positions").select("*")
      .eq("user_id", userId).eq("strategy_id", strategyId)
      .order("opened_at", { ascending: true }).limit(1000),
  ]);
  const shadow: LcTrade[] = [], paper: LcTrade[] = [];
  for (const r of (shadowRows ?? []) as Row[]) {
    const t = shadowRowToTrade(r);
    if (!t) continue;
    (String(r.mode ?? "shadow") === "paper" ? paper : shadow).push(t);
  }
  const live = ((posRows ?? []) as Row[]).map(positionRowToTrade).filter((t): t is LcTrade => !!t);
  return { shadow, paper, live };
}

export interface LifecycleEvaluation {
  strategyId: string;
  name: string;
  state: LifecycleState;
  previousState: LifecycleState;
  changed: boolean;
  score: number;
  allocationRiskPct: number;
  metrics: {
    w20: WindowMetrics; w50: WindowMetrics; w100: WindowMetrics; w300: WindowMetrics;
  };
  shadowMetrics: WindowMetrics;
  paperMetrics: WindowMetrics;
  liveMetrics: WindowMetrics;
  walkForward: ReturnType<typeof walkForward>;
  drift: ReturnType<typeof detectDrift>;
  regimes: ReturnType<typeof regimeBreakdown>;
  promotionChecks: RuleCheck[];
  demotionWarnings: string[];
  reason: string;
}

function activeStream(state: LifecycleState, s: LcTrade[], p: LcTrade[], l: LcTrade[]): LcTrade[] {
  if (state === "live") return l.length ? l : p;
  if (state === "paper") return p;
  return s;
}

export async function evaluateStrategyLifecycle(
  supabase: SupabaseClient, userId: string, strategy: Row,
): Promise<LifecycleEvaluation> {
  const strategyId = String(strategy.id);
  const previousState = (String(strategy.lifecycle_state ?? "shadow")) as LifecycleState;
  const { shadow, paper, live } = await loadStrategyTrades(supabase, userId, strategyId);

  const stream = activeStream(previousState, shadow, paper, live);
  const w20 = windowMetrics(stream, 20);
  const w50 = windowMetrics(stream, 50);
  const w100 = windowMetrics(stream, 100);
  const w300 = windowMetrics(stream, 300);
  const shadowMetrics = shadow.length ? windowMetrics(shadow) : { ...EMPTY_METRICS };
  const paperMetrics = paper.length ? windowMetrics(paper) : { ...EMPTY_METRICS };
  const liveMetrics = live.length ? windowMetrics(live) : { ...EMPTY_METRICS };

  const wf = walkForward(stream);
  const drift = detectDrift(stream);
  const regimes = regimeBreakdown(stream);

  const score = strategyScore(stream.length ? windowMetrics(stream, 300) : { ...EMPTY_METRICS });

  let nextState: LifecycleState = previousState;
  let reason = "no_change";
  let promotionChecks: RuleCheck[] = [];
  const demotionWarnings: string[] = [];

  // ---- Live monitoring: demotion / disable ----------------------------------
  if (previousState === "live") {
    const verdict = liveDemotionCheck(w50, w100, w300, drift);
    if (verdict.disable) { nextState = "disabled"; reason = verdict.reasons.join("; "); }
    else if (verdict.demote) { nextState = "paper"; reason = verdict.reasons.join("; "); }
    else if (score < MIN_LIVE_SCORE && w50.trades >= 20) {
      nextState = "paper"; reason = `score_${score}_below_live_threshold`;
    }
    if (verdict.reasons.length && nextState === previousState) demotionWarnings.push(...verdict.reasons);
  }

  // ---- Paper: promote to live, or demote back to shadow ---------------------
  if (previousState === "paper") {
    const recent50 = windowMetrics(paper, 50);
    promotionChecks = paperToLiveChecks(paperMetrics, recent50, 0);
    const sig = bootstrapSuperiority(paper.slice(-150).map(t => t.pnl), shadow.slice(-300).map(t => t.pnl));
    const statsOk = promotionChecks.every(c => c.passed);
    const regimeOk = regimes.length === 0 || regimes.some(r => r.trades >= 20 && r.profitFactor >= 1.4);
    if (statsOk && score >= MIN_LIVE_SCORE && regimeOk && (sig.significant || shadow.length < 20)) {
      nextState = "live"; reason = "passed_paper_to_live_gate";
    } else if (paperMetrics.trades >= 100 && paperMetrics.netPnl <= 0) {
      nextState = "shadow"; reason = "unprofitable_over_100_paper_trades";
    } else if (paperMetrics.trades >= 100 && paperMetrics.profitFactor < 1.0) {
      nextState = "disabled"; reason = "profit_factor_below_1.0_over_100_trades";
    } else if (!statsOk) {
      demotionWarnings.push(...promotionChecks.filter(c => !c.passed).map(c => `pending:${c.label}`));
    }
  }

  // ---- Shadow: promote to paper --------------------------------------------
  if (previousState === "shadow") {
    promotionChecks = shadowToPaperChecks(shadowMetrics);
    if (promotionChecks.every(c => c.passed)) { nextState = "paper"; reason = "passed_shadow_to_paper_gate"; }
    else if (shadowMetrics.trades >= 100 && shadowMetrics.consecutiveLosses >= 10) {
      nextState = "disabled"; reason = "10_consecutive_losses";
    }
  }

  // Drift: halve allocation, never auto-promote while drifting.
  let allocation = allocationForScore(score, nextState);
  if (drift.detected) {
    allocation = +(allocation * 0.5).toFixed(3);
    if (nextState === "live" && previousState !== "live") { nextState = previousState; reason = "promotion_paused_drift_detected"; }
  }
  if (nextState !== "live") allocation = 0;

  const changed = nextState !== previousState;

  await supabase.from("strategies").update({
    lifecycle_state: nextState,
    score,
    allocation_risk_pct: allocation,
    drift_detected: drift.detected,
    drift_at: drift.detected ? new Date().toISOString() : null,
    consecutive_losses: w50.consecutiveLosses,
    ...(changed ? { state_reason: reason, state_changed_at: new Date().toISOString() } : {}),
    is_active: nextState === "live" || nextState === "paper",
  }).eq("id", strategyId).eq("user_id", userId);

  await supabase.from("strategy_validation_runs").insert({
    user_id: userId, strategy_id: strategyId, state: nextState, score,
    windows: { w20, w50, w100, w300 } as never,
    walk_forward: { passRate: wf.passRate, latest: wf.latest, windows: wf.windows.slice(-10) } as never,
    regime_stats: regimes as never,
    drift: drift as never,
    eligibility: { promotionChecks, demotionWarnings, allocation } as never,
  });

  // Persist per-regime stats.
  for (const r of regimes) {
    await supabase.from("strategy_regime_stats").upsert({
      user_id: userId, strategy_id: strategyId, regime: r.regime,
      trades: r.trades, wins: r.wins, profit_factor: r.profitFactor,
      win_rate: r.winRate, expectancy: r.expectancy,
    }, { onConflict: "strategy_id,regime" });
  }

  if (changed) {
    await supabase.from("strategy_lifecycle_events").insert({
      user_id: userId, strategy_id: strategyId,
      from_state: previousState, to_state: nextState, reason,
      metrics: { score, w50, allocation } as never,
    });
    const promoted = ["shadow", "paper", "live"].indexOf(nextState) > ["shadow", "paper", "live"].indexOf(previousState);
    await emitNotification(supabase, userId, {
      kind: nextState === "disabled" ? "strategy.disabled" : promoted ? "strategy.promoted" : "strategy.demoted",
      severity: nextState === "disabled" ? "critical" : promoted ? "info" : "warning",
      title: `${strategy.name ?? "Strategy"} ${previousState} → ${nextState}`,
      message: `${reason}. Score ${score}/100, allocation ${allocation}% risk.`,
      payload: { strategyId, previousState, nextState, score, reason },
    });
  }
  if (drift.detected) {
    await emitNotification(supabase, userId, {
      kind: "strategy.drift",
      severity: "warning",
      title: `Concept drift — ${strategy.name ?? "strategy"}`,
      message: `${drift.reasons.join(", ")}. Allocation halved to ${allocation}%.`,
      payload: { strategyId, drift } as Record<string, unknown>,
    });
  }
  if (previousState === "live" && demotionWarnings.length) {
    await emitNotification(supabase, userId, {
      kind: "strategy.warning", severity: "warning",
      title: `Demotion warning — ${strategy.name ?? "strategy"}`,
      message: demotionWarnings.join("; "),
      payload: { strategyId } as Record<string, unknown>,
    });
  }

  return {
    strategyId, name: String(strategy.name ?? "Strategy"),
    state: nextState, previousState, changed, score, allocationRiskPct: allocation,
    metrics: { w20, w50, w100, w300 },
    shadowMetrics, paperMetrics, liveMetrics,
    walkForward: wf, drift, regimes,
    promotionChecks, demotionWarnings, reason,
  };
}

export async function evaluateAllStrategies(
  supabase: SupabaseClient, userId: string,
): Promise<LifecycleEvaluation[]> {
  const { data } = await supabase.from("strategies").select("*").eq("user_id", userId);
  const out: LifecycleEvaluation[] = [];
  for (const s of (data ?? []) as Row[]) {
    try { out.push(await evaluateStrategyLifecycle(supabase, userId, s)); }
    catch (e) { console.error("[lifecycle] evaluate failed", s.id, e); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Safety gate — the only path allowed to authorise a real order
// ---------------------------------------------------------------------------

export interface LiveGate {
  allowed: boolean;
  reason: string;
  strategyId: string | null;
  score: number;
  allocationRiskPct: number;
}

/**
 * A strategy may place a real order only when state == live, score >= 80,
 * no drift, and the most recent validation window is still profitable.
 * When the user has no saved strategies at all the gate is inert (the
 * autopilot's own risk breakers govern), so existing setups keep trading.
 */
export async function liveTradingGate(
  supabase: SupabaseClient, userId: string, symbol?: string,
): Promise<LiveGate> {
  const { data } = await supabase.from("strategies").select("*").eq("user_id", userId);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) {
    return { allowed: true, reason: "no_strategies_registered", strategyId: null, score: 0, allocationRiskPct: 0 };
  }
  const qualified = rows.filter(r =>
    String(r.lifecycle_state) === "live" &&
    num(r.score) >= MIN_LIVE_SCORE &&
    r.drift_detected !== true);
  if (qualified.length === 0) {
    return { allowed: false, reason: "no_strategy_qualified_for_live", strategyId: null, score: 0, allocationRiskPct: 0 };
  }
  const bySymbol = symbol ? qualified.filter(r => String(r.symbol) === symbol) : [];
  const pick = (bySymbol.length ? bySymbol : qualified)
    .sort((a, b) => num(b.score) - num(a.score))[0];

  // Recent validation window must still be profitable.
  const { data: runs } = await supabase.from("strategy_validation_runs")
    .select("windows").eq("user_id", userId).eq("strategy_id", String(pick.id))
    .order("created_at", { ascending: false }).limit(1);
  const w50 = (runs?.[0]?.windows as { w50?: WindowMetrics } | undefined)?.w50;
  if (w50 && w50.trades >= 20 && w50.netPnl <= 0) {
    return { allowed: false, reason: "recent_validation_window_unprofitable", strategyId: String(pick.id), score: num(pick.score), allocationRiskPct: 0 };
  }
  return {
    allowed: true, reason: "qualified",
    strategyId: String(pick.id), score: num(pick.score),
    allocationRiskPct: num(pick.allocation_risk_pct),
  };
}

// ---------------------------------------------------------------------------
// A/B testing + weekend retraining
// ---------------------------------------------------------------------------

export async function compareCandidates(
  supabase: SupabaseClient, userId: string, championId: string, challengerId: string,
) {
  const [a, b] = await Promise.all([
    loadStrategyTrades(supabase, userId, championId),
    loadStrategyTrades(supabase, userId, challengerId),
  ]);
  const champ = [...a.shadow, ...a.paper, ...a.live];
  const chall = [...b.shadow, ...b.paper, ...b.live];
  const ma = windowMetrics(champ), mb = windowMetrics(chall);
  const sig = bootstrapSuperiority(chall.map(t => t.pnl), champ.map(t => t.pnl));
  return {
    champion: { id: championId, metrics: ma, score: strategyScore(ma) },
    challenger: { id: challengerId, metrics: mb, score: strategyScore(mb) },
    significance: sig,
    verdict: sig.significant && mb.profitFactor > ma.profitFactor && mb.maxDrawdown <= ma.maxDrawdown
      ? "promote_challenger" : "keep_champion",
  };
}

/** Weekend retraining: re-derive weights from all closed trades, deploy to SHADOW. */
export async function runWeekendRetraining(
  supabase: SupabaseClient, userId: string, force = false,
): Promise<{ ran: boolean; version?: string; strategies: number }> {
  const now = new Date();
  const isWeekend = now.getUTCDay() === 0 || now.getUTCDay() === 6;
  if (!force && !isWeekend) return { ran: false, strategies: 0 };

  const { data: last } = await supabase.from("model_versions")
    .select("created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1);
  if (!force && last?.[0] && Date.now() - new Date(last[0].created_at as string).getTime() < 5 * 24 * 3600_000) {
    return { ran: false, strategies: 0 };
  }

  const { data: strategies } = await supabase.from("strategies").select("*").eq("user_id", userId);
  // Nothing to retrain: bail out BEFORE emitting anything. Previously this
  // path inserted no model_versions row, so the "last run < 5 days" cooldown
  // above never engaged and every cycle re-ran and re-notified ("0 strategies").
  if (!strategies || strategies.length === 0) return { ran: false, strategies: 0 };
  const version = `v${now.toISOString().slice(0, 10).replace(/-/g, "")}.${Math.floor(now.getTime() / 1000) % 10000}`;

  let inserted = 0;
  for (const s of (strategies ?? []) as Row[]) {
    const { shadow, paper, live } = await loadStrategyTrades(supabase, userId, String(s.id));
    const all = [...shadow, ...paper, ...live].sort((x, y) => x.ts - y.ts);
    const m = windowMetrics(all);
    const wf = walkForward(all);
    const regimes = regimeBreakdown(all);
    const importance: Record<string, number> = {};
    for (const r of regimes) importance[`regime:${r.regime}`] = +(r.profitFactor / (regimes.length || 1)).toFixed(3);
    importance["confidence"] = +(m.winRate).toFixed(3);
    importance["avg_r"] = +(m.avgR).toFixed(3);
    importance["execution_quality"] = +(m.executionQuality).toFixed(3);

    const { error } = await supabase.from("model_versions").insert({
      user_id: userId, strategy_id: String(s.id), version, state: "shadow",
      training_window: { trades: all.length, from: all[0]?.ts ?? null, to: all[all.length - 1]?.ts ?? null } as never,
      feature_importance: importance as never,
      validation_metrics: { metrics: m, walkForwardPassRate: wf.passRate, score: strategyScore(m) } as never,
      is_candidate: true,
    });
    if (!error) inserted++;
  }

  // A retrain that produced no candidate model is a no-op: no notification.
  // Without this, a failed/empty run left no model_versions row, the 5-day
  // cooldown above never engaged, and every single cron minute re-notified.
  if (inserted === 0) return { ran: false, strategies: 0 };

  await emitNotification(supabase, userId, {
    kind: "model.retrained", severity: "info",
    title: `Retraining complete — ${version}`,
    message: `Candidate models deployed to SHADOW for ${inserted} strateg${inserted === 1 ? "y" : "ies"}. They must earn promotion before trading live.`,
    payload: { version },
  });

  return { ran: true, version, strategies: inserted };
}

