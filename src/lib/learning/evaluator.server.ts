// Self-learning engine.
//
// Every 100 closed trades the platform reviews its own performance, scores
// each strategy and adjusts the confidence weights the autonomous engine uses.
// Strategies that fall below the minimum quality bar are disabled until they
// recover in shadow/backtest mode.
import type { SupabaseClient } from "@supabase/supabase-js";
import { performanceStats } from "@/lib/analysis/institutional";

export const EVALUATION_INTERVAL = 100;

export interface StrategyWeight {
  strategy: string;
  weight: number;
  profitFactor: number;
  winRate: number;
  expectancy: number;
  sampleSize: number;
  enabled: boolean;
}

interface ClosedTrade {
  realized_pnl: number | null;
  avg_entry: number | null;
  stop_loss: number | null;
  qty: number | null;
  ai_regime: string | null;
  closed_at: string | null;
  symbol: string;
}

function strategyKeyFor(t: ClosedTrade): string {
  const regime = t.ai_regime ?? "unknown";
  if (regime.startsWith("trending")) return "trend_following";
  if (regime === "ranging") return "mean_reversion";
  if (regime === "high_volatility") return "breakout";
  return "unclassified";
}

/** Score 0..100 blending profit factor, expectancy, win rate and sample size. */
export function scoreStrategy(pf: number, winRate: number, expectancy: number, n: number): number {
  const pfScore = Math.min(40, Math.max(0, (pf - 1) * 40));
  const wrScore = Math.min(25, winRate * 50);
  const expScore = expectancy > 0 ? 25 : 0;
  const confidence = Math.min(10, (n / 30) * 10);
  return Math.round(pfScore + wrScore + expScore + confidence);
}

export async function runLearningEvaluation(
  supabase: SupabaseClient,
  userId: string,
  opts: { force?: boolean } = {},
): Promise<{ ran: boolean; reason?: string; evaluationId?: string; adjustments: unknown[] }> {
  const { count } = await supabase.from("positions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("status", "closed");
  const total = count ?? 0;

  const { data: lastEval } = await supabase.from("learning_evaluations")
    .select("trades_evaluated, created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const lastCount = Number(lastEval?.trades_evaluated ?? 0);

  if (!opts.force && total - lastCount < EVALUATION_INTERVAL) {
    return {
      ran: false,
      reason: `${total - lastCount}/${EVALUATION_INTERVAL} trades since the last review.`,
      adjustments: [],
    };
  }

  const { data: trades } = await supabase.from("positions")
    .select("realized_pnl, avg_entry, stop_loss, qty, ai_regime, closed_at, symbol")
    .eq("user_id", userId).eq("status", "closed")
    .order("closed_at", { ascending: true })
    .limit(500);

  const rows = (trades ?? []) as ClosedTrade[];
  if (rows.length < 10) {
    return { ran: false, reason: "Not enough closed trades to learn from yet (min 10).", adjustments: [] };
  }

  const pnls = rows.map(t => Number(t.realized_pnl ?? 0));
  const rMultiples = rows.map(t => {
    const risk = Math.abs(Number(t.avg_entry ?? 0) - Number(t.stop_loss ?? 0)) * Math.abs(Number(t.qty ?? 0));
    return risk > 0 ? Number(t.realized_pnl ?? 0) / risk : 0;
  }).filter(x => Number.isFinite(x));
  const overall = performanceStats(pnls, rMultiples);

  // Per-strategy breakdown
  const buckets = new Map<string, number[]>();
  for (const t of rows) {
    const k = strategyKeyFor(t);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(Number(t.realized_pnl ?? 0));
  }

  const adjustments: Array<Record<string, unknown>> = [];
  for (const [strategy, list] of buckets) {
    const s = performanceStats(list);
    const score = scoreStrategy(s.profitFactor, s.winRate, s.expectancy, s.trades);
    // Weight maps score 0..100 onto a 0.5..1.5 confidence multiplier.
    const weight = +(0.5 + (score / 100)).toFixed(3);
    const enabled = s.trades < 20 ? true : s.profitFactor >= 1.1 && s.expectancy > 0;

    await supabase.from("strategy_weights").upsert({
      user_id: userId, strategy, weight,
      profit_factor: +s.profitFactor.toFixed(3),
      win_rate: +s.winRate.toFixed(4),
      expectancy: +s.expectancy.toFixed(4),
      sample_size: s.trades,
      enabled,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,strategy" });

    adjustments.push({
      strategy, score, weight, enabled,
      profitFactor: +s.profitFactor.toFixed(2),
      winRate: +(s.winRate * 100).toFixed(1),
      trades: s.trades,
      action: enabled ? (weight > 1.1 ? "increase_allocation" : "maintain") : "disabled_pending_recovery",
    });
  }

  const { data: inserted } = await supabase.from("learning_evaluations").insert({
    user_id: userId,
    trades_evaluated: total,
    window_start: rows[0]?.closed_at ?? null,
    window_end: rows[rows.length - 1]?.closed_at ?? null,
    win_rate: +overall.winRate.toFixed(4),
    profit_factor: +overall.profitFactor.toFixed(3),
    sharpe: +overall.sharpe.toFixed(3),
    sortino: +overall.sortino.toFixed(3),
    expectancy: +overall.expectancy.toFixed(4),
    avg_r: +overall.avgR.toFixed(3),
    max_drawdown_pct: overall.maxDrawdownPct,
    adjustments,
  }).select("id").maybeSingle();

  return { ran: true, evaluationId: inserted?.id, adjustments };
}

export async function getStrategyWeights(
  supabase: SupabaseClient, userId: string,
): Promise<StrategyWeight[]> {
  const { data } = await supabase.from("strategy_weights").select("*").eq("user_id", userId);
  return (data ?? []).map(r => ({
    strategy: r.strategy,
    weight: Number(r.weight),
    profitFactor: Number(r.profit_factor ?? 0),
    winRate: Number(r.win_rate ?? 0),
    expectancy: Number(r.expectancy ?? 0),
    sampleSize: Number(r.sample_size ?? 0),
    enabled: Boolean(r.enabled),
  }));
}
