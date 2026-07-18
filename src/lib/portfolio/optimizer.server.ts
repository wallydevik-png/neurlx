// Strategy Optimization Engine. Grid-searches parameter combinations over
// the historical backtest engine and returns a ranked list of results.
// Server-only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { runBacktest, type BacktestParams } from "@/lib/backtest/engine.server";

export interface OptimizationGrid {
  minConfidence?: number[];
  riskPerTradePct?: number[];
  maxBarsInTrade?: number[];
  slippageBps?: number[];
  feeBps?: number[];
}

export interface OptimizationCandidate {
  params: Record<string, number>;
  metrics: {
    totalReturn: number; sharpe: number; sortino: number;
    profitFactor: number; winRate: number; maxDrawdown: number; trades: number;
  };
  score: number;
}

export interface OptimizationResult {
  base: Omit<BacktestParams, keyof OptimizationGrid>;
  candidates: OptimizationCandidate[];
  best: OptimizationCandidate;
}

function cross(grid: OptimizationGrid): Record<string, number>[] {
  const keys = Object.keys(grid) as (keyof OptimizationGrid)[];
  const vals = keys.map(k => grid[k] ?? []);
  const out: Record<string, number>[] = [{}];
  for (let i = 0; i < keys.length; i++) {
    const next: Record<string, number>[] = [];
    for (const combo of out) for (const v of vals[i]) next.push({ ...combo, [keys[i]]: v });
    if (next.length) out.length = 0, out.push(...next);
  }
  return out;
}

// Rank: Sortino-heavy, penalise drawdown, need at least 8 trades.
function scoreCandidate(m: OptimizationCandidate["metrics"]): number {
  if (m.trades < 8) return -Infinity;
  const dd = Math.max(0.01, Math.abs(m.maxDrawdown));
  return m.sortino * 0.5 + m.sharpe * 0.3 + m.profitFactor * 0.2 - dd * 2;
}

export async function runOptimization(
  supabase: SupabaseClient | null,
  base: BacktestParams,
  grid: OptimizationGrid,
): Promise<OptimizationResult> {
  const combos = cross(grid).slice(0, 40); // safety cap
  const candidates: OptimizationCandidate[] = [];
  for (const combo of combos) {
    const merged: BacktestParams = { ...base, ...combo };
    try {
      const r = await runBacktest(supabase, merged);
      const m = {
        totalReturn: r.metrics.totalReturn,
        sharpe: r.metrics.sharpe,
        sortino: r.metrics.sortino,
        profitFactor: r.metrics.profitFactor,
        winRate: r.metrics.winRate,
        maxDrawdown: r.metrics.maxDrawdown,
        trades: r.trades.length,
      };
      candidates.push({ params: combo, metrics: m, score: scoreCandidate(m) });
    } catch { /* skip failing combo */ }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0] ?? { params: {}, metrics: {
    totalReturn: 0, sharpe: 0, sortino: 0, profitFactor: 0, winRate: 0, maxDrawdown: 0, trades: 0,
  }, score: -Infinity };
  return { base, candidates, best };
}
