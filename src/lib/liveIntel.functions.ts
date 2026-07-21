// Live Trading Intelligence & Performance Feedback Loop
// -----------------------------------------------------------------------------
// Analytics over closed live/paper trades. Compares live results to shadow
// and backtest baselines. Feeds an updated readiness assessment WITHOUT
// automatically enabling autonomous mode.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";

// -----------------------------------------------------------------------------
// Capital snapshots
// -----------------------------------------------------------------------------
export async function snapshotCapitalInternal(supabase: SupabaseClient, userId: string) {
  const [acctR, posR, journalR] = await Promise.all([
    supabase.from("paper_accounts").select("cash_balance,realized_pnl").eq("user_id", userId).maybeSingle(),
    supabase.from("positions").select("qty,avg_entry,side,ai_regime,stop_loss").eq("user_id", userId).eq("status", "open"),
    supabase.from("trade_journal").select("realized_pnl").eq("user_id", userId),
  ]);
  const cash = Number(acctR.data?.cash_balance ?? 0);
  const positions = posR.data ?? [];
  // Unrealized as approx = 0 (mark-to-market would need a live quote loop).
  const grossExposure = positions.reduce((s, p) => s + Number(p.qty) * Number(p.avg_entry), 0);
  const realizedTotal = (journalR.data ?? []).reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
  const equity = cash + grossExposure;
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from("capital_snapshots").upsert({
    user_id: userId, snapshot_date: today,
    cash_balance: cash, unrealized_pnl: 0,
    realized_pnl_total: realizedTotal, equity,
    open_positions: positions.length, gross_exposure: grossExposure,
  }, { onConflict: "user_id,snapshot_date" });
}

export const snapshotCapital = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await snapshotCapitalInternal(context.supabase, context.userId);
    return { ok: true };
  });

// -----------------------------------------------------------------------------
// Live Trade Analytics — calibration + breakdowns
// -----------------------------------------------------------------------------
type JournalRow = {
  symbol: string; side: string; ai_confidence: number | string | null;
  market_regime: string | null; strategy_id: string | null;
  entry_price: number | string | null; exit_price: number | string | null;
  qty: number | string | null; realized_pnl: number | string | null;
  fees_total: number | string | null; slippage_bps_avg: number | string | null;
  execution_latency_ms: number | null; duration_seconds: number | null;
  exit_reason: string | null; predicted_outcome: string | null;
  actual_outcome: string | null; created_at: string;
  attribution: Record<string, unknown> | null;
};

function bucket(row: JournalRow) {
  const c = Number(row.ai_confidence ?? 0);
  if (c >= 0.85) return "90%+";
  if (c >= 0.75) return "75-85%";
  if (c >= 0.65) return "65-75%";
  if (c >= 0.5) return "50-65%";
  return "<50%";
}

export const getLiveTradeAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("trade_journal")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(500);
    const rows = (data ?? []) as JournalRow[];

    // Calibration: predicted win rate at each confidence bucket vs actual.
    const buckets = new Map<string, { n: number; wins: number; totalPnl: number; predWins: number }>();
    for (const r of rows) {
      const k = bucket(r);
      const b = buckets.get(k) ?? { n: 0, wins: 0, totalPnl: 0, predWins: 0 };
      b.n += 1;
      b.totalPnl += Number(r.realized_pnl ?? 0);
      if (Number(r.realized_pnl ?? 0) > 0) b.wins += 1;
      if (r.predicted_outcome === "win") b.predWins += 1;
      buckets.set(k, b);
    }
    const order = ["90%+", "75-85%", "65-75%", "50-65%", "<50%"];
    const calibration = order.filter(k => buckets.has(k)).map(k => {
      const b = buckets.get(k)!;
      return {
        bucket: k, n: b.n, winRate: b.n ? b.wins / b.n : 0,
        predictedRate: b.n ? b.predWins / b.n : 0, totalPnl: b.totalPnl,
      };
    });

    // Grouped breakdowns
    function group<K extends string>(key: (r: JournalRow) => K | null) {
      const m = new Map<K, { n: number; wins: number; pnl: number; avgConf: number }>();
      for (const r of rows) {
        const k = key(r); if (!k) continue;
        const cur = m.get(k) ?? { n: 0, wins: 0, pnl: 0, avgConf: 0 };
        cur.n += 1;
        cur.pnl += Number(r.realized_pnl ?? 0);
        if (Number(r.realized_pnl ?? 0) > 0) cur.wins += 1;
        cur.avgConf += Number(r.ai_confidence ?? 0);
        m.set(k, cur);
      }
      return [...m.entries()].map(([k, v]) => ({
        key: k, n: v.n, winRate: v.n ? v.wins / v.n : 0,
        totalPnl: v.pnl, avgConf: v.n ? v.avgConf / v.n : 0,
      })).sort((a, b) => b.n - a.n);
    }

    const byAsset = group(r => r.symbol);
    const byRegime = group(r => r.market_regime);
    const byStrategy = group(r => r.strategy_id);
    const byHorizon = group(r => {
      const s = r.duration_seconds ?? 0;
      if (s < 3600) return "<1h";
      if (s < 4 * 3600) return "1-4h";
      if (s < 24 * 3600) return "4-24h";
      return ">1d";
    });

    // Aggregates
    const wins = rows.filter(r => Number(r.realized_pnl ?? 0) > 0);
    const losses = rows.filter(r => Number(r.realized_pnl ?? 0) < 0);
    const totalPnl = rows.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
    const grossWin = wins.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0));

    const latencies = rows.map(r => r.execution_latency_ms ?? 0).filter(n => n > 0).sort((a, b) => a - b);
    const avgSlip = rows.length
      ? rows.reduce((s, r) => s + Number(r.slippage_bps_avg ?? 0), 0) / rows.length : 0;

    return {
      overview: {
        n: rows.length,
        winRate: rows.length ? wins.length / rows.length : 0,
        totalPnl, grossWin, grossLoss,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
        avgLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0,
        avgSlippageBps: avgSlip,
      },
      calibration,
      byAsset, byRegime, byStrategy, byHorizon,
    };
  });

// -----------------------------------------------------------------------------
// Trade attribution summary — which indicators explain wins vs losses
// -----------------------------------------------------------------------------
export const getTradeAttribution = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("trade_journal")
      .select("realized_pnl,attribution,exit_reason,strategy_id").eq("user_id", context.userId).limit(500);
    const rows = (data ?? []) as Array<{
      realized_pnl: number | string | null; attribution: Record<string, unknown> | null;
      exit_reason: string | null; strategy_id: string | null;
    }>;

    const indicatorScore = new Map<string, { wins: number; losses: number; pnl: number }>();
    let executionHurt = 0, executionHelped = 0, aiCorrect = 0, aiWrong = 0;
    let stopHit = 0, tpHit = 0, manual = 0;

    for (const r of rows) {
      const attr = r.attribution ?? {};
      const pnl = Number(r.realized_pnl ?? 0);
      const winInds = (attr.winning_indicators as string[]) ?? [];
      const lossInds = (attr.losing_indicators as string[]) ?? [];
      for (const name of winInds) {
        const s = indicatorScore.get(name) ?? { wins: 0, losses: 0, pnl: 0 };
        s.wins += 1; s.pnl += pnl; indicatorScore.set(name, s);
      }
      for (const name of lossInds) {
        const s = indicatorScore.get(name) ?? { wins: 0, losses: 0, pnl: 0 };
        s.losses += 1; s.pnl += pnl; indicatorScore.set(name, s);
      }
      if (attr.execution_helped === true) executionHelped += 1;
      else if (attr.execution_helped === false) executionHurt += 1;
      if (attr.ai_prediction_correct === true) aiCorrect += 1;
      else if (attr.ai_prediction_correct === false) aiWrong += 1;
      if (r.exit_reason === "stop_loss") stopHit += 1;
      else if (r.exit_reason === "take_profit") tpHit += 1;
      else if (r.exit_reason === "manual") manual += 1;
    }

    const indicators = [...indicatorScore.entries()].map(([name, s]) => ({
      name, wins: s.wins, losses: s.losses,
      hitRate: s.wins + s.losses > 0 ? s.wins / (s.wins + s.losses) : 0,
      totalPnl: s.pnl,
    })).sort((a, b) => b.totalPnl - a.totalPnl);

    return {
      indicators,
      execution: { helped: executionHelped, hurt: executionHurt },
      aiPrediction: { correct: aiCorrect, wrong: aiWrong },
      exits: { stopHit, tpHit, manual, total: rows.length },
    };
  });

// -----------------------------------------------------------------------------
// Live strategy health — recent perf, drawdown, alpha decay
// -----------------------------------------------------------------------------
export const getLiveStrategyHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [stratsR, journalR] = await Promise.all([
      supabase.from("strategies").select("id,name,strategy_type,health_status,is_active").eq("user_id", userId),
      supabase.from("trade_journal").select("strategy_id,realized_pnl,created_at").eq("user_id", userId).limit(1000),
    ]);
    const strats = stratsR.data ?? [];
    const journal = (journalR.data ?? []) as Array<{
      strategy_id: string | null; realized_pnl: number | string | null; created_at: string;
    }>;
    const now = Date.now();
    const cutoff30 = now - 30 * 86400 * 1000;
    const cutoff7 = now - 7 * 86400 * 1000;

    const rows = strats.map(s => {
      const trades = journal.filter(j => j.strategy_id === s.id);
      const recent30 = trades.filter(j => new Date(j.created_at).getTime() >= cutoff30);
      const recent7 = trades.filter(j => new Date(j.created_at).getTime() >= cutoff7);
      const wr30 = recent30.length ? recent30.filter(t => Number(t.realized_pnl ?? 0) > 0).length / recent30.length : 0;
      const wr7 = recent7.length ? recent7.filter(t => Number(t.realized_pnl ?? 0) > 0).length / recent7.length : 0;
      const pnl30 = recent30.reduce((a, t) => a + Number(t.realized_pnl ?? 0), 0);

      // Drawdown from running equity
      let peak = 0, dd = 0, running = 0;
      for (const t of trades.slice().reverse()) {
        running += Number(t.realized_pnl ?? 0);
        if (running > peak) peak = running;
        const cur = peak - running; if (cur > dd) dd = cur;
      }

      let flag: "healthy" | "degrading" | "pause" = "healthy";
      if (recent30.length >= 5 && wr7 < wr30 - 0.15) flag = "degrading";
      if (recent7.length >= 3 && wr7 < 0.3) flag = "pause";

      return {
        id: s.id, name: s.name, type: s.strategy_type,
        isActive: s.is_active, storedHealth: s.health_status,
        trades30: recent30.length, trades7: recent7.length,
        winRate30: wr30, winRate7: wr7, pnl30, drawdown: dd, liveFlag: flag,
      };
    });

    return rows.sort((a, b) => b.trades30 - a.trades30);
  });

// -----------------------------------------------------------------------------
// Comparison: Backtest vs Shadow vs Live
// -----------------------------------------------------------------------------
type Metrics = { n: number; winRate: number; totalPnl: number; avgPnl: number; sharpe: number; maxDd: number };

function metricsFromReturns(returns: number[]): Metrics {
  const n = returns.length;
  if (!n) return { n: 0, winRate: 0, totalPnl: 0, avgPnl: 0, sharpe: 0, maxDd: 0 };
  const wins = returns.filter(r => r > 0).length;
  const total = returns.reduce((a, b) => a + b, 0);
  const avg = total / n;
  const variance = returns.reduce((a, r) => a + (r - avg) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;
  let peak = 0, dd = 0, cum = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const cur = peak - cum; if (cur > dd) dd = cur;
  }
  return { n, winRate: wins / n, totalPnl: total, avgPnl: avg, sharpe, maxDd: dd };
}

export const getComparisonDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [btR, shR, jR] = await Promise.all([
      supabase.from("backtest_runs").select("metrics,equity_curve,kind").eq("user_id", userId).limit(50),
      supabase.from("shadow_trades").select("pnl,pnl_pct,status").eq("user_id", userId).eq("status", "closed"),
      supabase.from("trade_journal").select("realized_pnl,slippage_bps_avg,fees_total,execution_quality_score").eq("user_id", userId),
    ]);

    const bt = (btR.data ?? []).filter(r => r.kind === "single" || r.kind === "walkforward_oos");
    const btBest = bt.reduce((best, r) => {
      const m = (r.metrics ?? {}) as { sharpe?: number };
      return Number(m.sharpe ?? 0) > (best?.sharpe ?? -Infinity)
        ? { ...(m as Record<string, number>), sharpe: Number(m.sharpe ?? 0) } : best;
    }, null as null | Record<string, number>);

    const shadowReturns = (shR.data ?? []).map(t => Number(t.pnl ?? 0));
    const shadowMetrics = metricsFromReturns(shadowReturns);

    const liveReturns = (jR.data ?? []).map(t => Number(t.realized_pnl ?? 0));
    const liveMetrics = metricsFromReturns(liveReturns);
    const liveJournal = jR.data ?? [];
    const avgSlip = liveJournal.length
      ? liveJournal.reduce((s, r) => s + Number(r.slippage_bps_avg ?? 0), 0) / liveJournal.length : 0;
    const avgQuality = liveJournal.length
      ? liveJournal.reduce((s, r) => s + Number(r.execution_quality_score ?? 0), 0) / liveJournal.length : 0;
    const totalFees = liveJournal.reduce((s, r) => s + Number(r.fees_total ?? 0), 0);

    return {
      backtest: btBest ? {
        n: Number(btBest.trades ?? 0), winRate: Number(btBest.winRate ?? 0),
        totalPnl: Number(btBest.totalReturn ?? 0), sharpe: Number(btBest.sharpe ?? 0),
        maxDd: Math.abs(Number(btBest.maxDrawdown ?? 0)), profitFactor: Number(btBest.profitFactor ?? 0),
      } : null,
      shadow: shadowMetrics,
      live: liveMetrics,
      execution: {
        avgSlippageBps: avgSlip, avgQuality, totalFees,
      },
    };
  });

// -----------------------------------------------------------------------------
// Capital growth series
// -----------------------------------------------------------------------------
export const getCapitalGrowth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Auto-snapshot before reading so today's row exists
    await snapshotCapitalInternal(supabase, userId);
    const [snapsR, acctR, posR, journalR] = await Promise.all([
      supabase.from("capital_snapshots").select("*").eq("user_id", userId)
        .order("snapshot_date", { ascending: true }).limit(365),
      supabase.from("paper_accounts").select("cash_balance,realized_pnl").eq("user_id", userId).maybeSingle(),
      supabase.from("positions").select("qty,avg_entry").eq("user_id", userId).eq("status", "open"),
      supabase.from("trade_journal").select("realized_pnl,created_at").eq("user_id", userId).order("created_at", { ascending: true }),
    ]);
    const snaps = snapsR.data ?? [];
    const positions = posR.data ?? [];
    const grossExposure = positions.reduce((s, p) => s + Number(p.qty) * Number(p.avg_entry), 0);
    const cash = Number(acctR.data?.cash_balance ?? 0);
    const equity = cash + grossExposure;

    const first = snaps[0]?.equity ? Number(snaps[0].equity) : equity;
    const compoundPct = first > 0 ? (equity / first - 1) : 0;

    // Monthly returns from journal
    const monthMap = new Map<string, number>();
    for (const t of (journalR.data ?? [])) {
      const d = new Date(t.created_at);
      const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      monthMap.set(k, (monthMap.get(k) ?? 0) + Number(t.realized_pnl ?? 0));
    }
    const monthly = [...monthMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, pnl]) => ({ month, pnl }));

    const realizedTotal = Number(acctR.data?.realized_pnl ?? 0);

    return {
      current: {
        cash, equity, unrealizedPnl: 0, realizedTotal,
        openPositions: positions.length, grossExposure,
        exposurePct: equity > 0 ? grossExposure / equity : 0,
      },
      compoundPct, firstSnapshotEquity: first,
      series: snaps.map(s => ({
        date: s.snapshot_date, equity: Number(s.equity),
        cash: Number(s.cash_balance), realized: Number(s.realized_pnl_total),
      })),
      monthly,
      withdrawalHistory: [] as { date: string; amount: number; note: string }[],
    };
  });
