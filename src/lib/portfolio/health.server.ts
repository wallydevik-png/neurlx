// Strategy health monitoring. Scores each strategy from its backtest history
// (sharpe/profit factor decay, drawdown creep) and flags "underperforming"
// or "consider disabling" states. Called on demand from the strategies page.
import type { SupabaseClient } from "@supabase/supabase-js";

export type HealthStatus = "healthy" | "watch" | "underperforming" | "consider_disabling" | "unmonitored";

export interface StrategyHealth {
  strategyId: string;
  status: HealthStatus;
  notes: string;
  metrics: {
    runs: number;
    latestSharpe: number | null;
    latestProfitFactor: number | null;
    latestMaxDrawdown: number | null;
    sharpeTrend: number | null;   // latest - previous
    ddTrend: number | null;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Metrics = any;

export async function evaluateStrategyHealth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId: string,
  strategyId: string,
): Promise<StrategyHealth> {
  const { data: runs } = await supabase.from("backtest_runs")
    .select("metrics,created_at")
    .eq("user_id", userId).eq("strategy_id", strategyId)
    .in("kind", ["single", "walkforward_oos"])
    .order("created_at", { ascending: false }).limit(6);

  const list = runs ?? [];
  if (!list.length) {
    return {
      strategyId, status: "unmonitored",
      notes: "No backtests linked to this strategy yet. Run a backtest to enable monitoring.",
      metrics: { runs: 0, latestSharpe: null, latestProfitFactor: null, latestMaxDrawdown: null, sharpeTrend: null, ddTrend: null },
    };
  }
  const latest = list[0].metrics as Metrics;
  const prev = list[1]?.metrics as Metrics | undefined;
  const sharpe = Number(latest?.sharpe ?? 0);
  const pf = Number(latest?.profitFactor ?? 0);
  const dd = Number(latest?.maxDrawdown ?? 0);
  const sharpeTrend = prev ? sharpe - Number(prev.sharpe ?? 0) : null;
  const ddTrend = prev ? dd - Number(prev.maxDrawdown ?? 0) : null;

  const notes: string[] = [];
  let status: HealthStatus = "healthy";
  if (sharpe < 0) { notes.push(`Latest Sharpe ${sharpe.toFixed(2)} is negative.`); status = "consider_disabling"; }
  else if (sharpe < 0.5) { notes.push(`Latest Sharpe ${sharpe.toFixed(2)} below 0.5.`); status = "underperforming"; }
  if (pf < 1 && list.length > 0) { notes.push(`Profit factor ${pf.toFixed(2)} < 1 — losing more than winning.`); if (status === "healthy") status = "underperforming"; }
  if (dd > 0.25) { notes.push(`Max drawdown ${(dd*100).toFixed(1)}% is elevated.`); if (status === "healthy") status = "watch"; }
  if (sharpeTrend !== null && sharpeTrend < -0.4) { notes.push(`Sharpe decayed by ${sharpeTrend.toFixed(2)} vs previous run.`); if (status === "healthy") status = "watch"; }
  if (ddTrend !== null && ddTrend > 0.08) { notes.push(`Drawdown grew by ${(ddTrend*100).toFixed(1)}pp vs previous run.`); if (status === "healthy") status = "watch"; }
  if (!notes.length) notes.push("Performance within expected envelope.");

  const health: StrategyHealth = {
    strategyId, status, notes: notes.join(" "),
    metrics: {
      runs: list.length, latestSharpe: sharpe, latestProfitFactor: pf,
      latestMaxDrawdown: dd, sharpeTrend, ddTrend,
    },
  };
  await supabase.from("strategies").update({
    health_status: status, health_notes: health.notes,
    last_evaluated_at: new Date().toISOString(),
  }).eq("id", strategyId).eq("user_id", userId);
  return health;
}
