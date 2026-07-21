// Advanced Analytics — monthly returns, symbol/strategy breakdowns,
// risk-adjusted metrics, benchmark comparison, tax-lot exports.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Row = {
  symbol: string; side: string; strategy_id: string | null;
  qty: number | string | null; entry_price: number | string | null;
  exit_price: number | string | null; realized_pnl: number | string | null;
  fees_total: number | string | null; slippage_bps_avg: number | string | null;
  duration_seconds: number | null; exit_reason: string | null;
  market_regime: string | null; ai_confidence: number | string | null;
  created_at: string; 
};

function n(v: unknown) { return Number(v ?? 0); }

function stats(pnls: number[]) {
  if (!pnls.length) return { mean: 0, std: 0, downside: 0 };
  const mean = pnls.reduce((s, x) => s + x, 0) / pnls.length;
  const varr = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / pnls.length;
  const dn = pnls.filter(x => x < 0);
  const dv = dn.length ? dn.reduce((s, x) => s + x * x, 0) / dn.length : 0;
  return { mean, std: Math.sqrt(varr), downside: Math.sqrt(dv) };
}

export const getAdvancedAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [jR, snapR] = await Promise.all([
      supabase.from("trade_journal").select("*").eq("user_id", userId).order("created_at", { ascending: true }),
      supabase.from("capital_snapshots").select("snapshot_date,equity,realized_pnl_total").eq("user_id", userId).order("snapshot_date", { ascending: true }),
    ]);
    const rows = (jR.data ?? []) as Row[];
    const snaps = snapR.data ?? [];

    // Monthly returns
    const byMonth = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const r of rows) {
      const d = new Date(r.created_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const cur = byMonth.get(key) ?? { pnl: 0, trades: 0, wins: 0 };
      cur.pnl += n(r.realized_pnl); cur.trades += 1; if (n(r.realized_pnl) > 0) cur.wins += 1;
      byMonth.set(key, cur);
    }
    const monthly = Array.from(byMonth.entries()).map(([month, v]) => ({ month, ...v, winRate: v.trades ? v.wins / v.trades : 0 }));

    // Symbol breakdown
    const bySym = new Map<string, { pnl: number; trades: number; wins: number; fees: number }>();
    for (const r of rows) {
      const cur = bySym.get(r.symbol) ?? { pnl: 0, trades: 0, wins: 0, fees: 0 };
      cur.pnl += n(r.realized_pnl); cur.trades += 1; cur.fees += n(r.fees_total);
      if (n(r.realized_pnl) > 0) cur.wins += 1;
      bySym.set(r.symbol, cur);
    }
    const symbols = Array.from(bySym.entries())
      .map(([symbol, v]) => ({ symbol, ...v, winRate: v.trades ? v.wins / v.trades : 0 }))
      .sort((a, b) => b.pnl - a.pnl);

    // Strategy breakdown
    const byStrat = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const r of rows) {
      const k = r.strategy_id ?? "unassigned";
      const cur = byStrat.get(k) ?? { pnl: 0, trades: 0, wins: 0 };
      cur.pnl += n(r.realized_pnl); cur.trades += 1; if (n(r.realized_pnl) > 0) cur.wins += 1;
      byStrat.set(k, cur);
    }
    const strategies = Array.from(byStrat.entries())
      .map(([strategy_id, v]) => ({ strategy_id, ...v, winRate: v.trades ? v.wins / v.trades : 0 }))
      .sort((a, b) => b.pnl - a.pnl);

    // Best / worst trades
    const sorted = [...rows].sort((a, b) => n(b.realized_pnl) - n(a.realized_pnl));
    const bestTrades = sorted.slice(0, 5).map(r => ({
      symbol: r.symbol, side: r.side, pnl: n(r.realized_pnl),
      closed_at: r.created_at, exit_reason: r.exit_reason,
    }));
    const worstTrades = sorted.slice(-5).reverse().map(r => ({
      symbol: r.symbol, side: r.side, pnl: n(r.realized_pnl),
      closed_at: r.created_at, exit_reason: r.exit_reason,
    }));

    // Daily returns from snapshots → Sharpe / Sortino / Calmar
    const daily: number[] = [];
    for (let i = 1; i < snaps.length; i++) {
      const prev = n(snaps[i - 1].equity), cur = n(snaps[i].equity);
      if (prev > 0) daily.push((cur - prev) / prev);
    }
    const { mean, std, downside } = stats(daily);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
    const sortino = downside > 0 ? (mean / downside) * Math.sqrt(252) : 0;

    // Max drawdown from equity curve
    let peak = 0, maxDd = 0;
    for (const s of snaps) {
      const eq = n(s.equity);
      if (eq > peak) peak = eq;
      if (peak > 0) { const dd = (peak - eq) / peak; if (dd > maxDd) maxDd = dd; }
    }
    const annualReturn = mean * 252;
    const calmar = maxDd > 0 ? annualReturn / maxDd : 0;

    // Exposure / hold time
    const durations = rows.map(r => Number(r.duration_seconds ?? 0)).filter(x => x > 0);
    const avgHoldMin = durations.length ? durations.reduce((s, x) => s + x, 0) / durations.length / 60 : 0;

    const totalPnl = rows.reduce((s, r) => s + n(r.realized_pnl), 0);
    const totalFees = rows.reduce((s, r) => s + n(r.fees_total), 0);

    return {
      monthly, symbols, strategies, bestTrades, worstTrades,
      risk: { sharpe, sortino, calmar, maxDrawdown: maxDd, annualReturn, volatility: std * Math.sqrt(252) },
      summary: { totalPnl, totalFees, totalTrades: rows.length, avgHoldMin },
      equityCurve: snaps.map(s => ({ date: s.snapshot_date, equity: n(s.equity) })),
    };
  });

// Tax report — closed trades as CSV rows (FIFO already realized in journal)
export const getTaxReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { year: number }) => d)
  .handler(async ({ data, context }) => {
    const from = `${data.year}-01-01`;
    const to = `${data.year + 1}-01-01`;
    const { data: rows } = await context.supabase
      .from("trade_journal")
      .select("symbol,side,qty,entry_price,exit_price,realized_pnl,fees_total,created_at")
      .eq("user_id", context.userId)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: true });
    return { year: data.year, rows: rows ?? [] };
  });
