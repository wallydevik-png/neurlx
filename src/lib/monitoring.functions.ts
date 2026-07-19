// Live monitoring + AI Readiness Score server functions. Read-only.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ---------- Live Monitoring ----------

export const getLiveMonitoring = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [connsR, posR, acctR] = await Promise.all([
      supabase.from("exchange_connections")
        .select("id,label,connector_id,status,health,trading_enabled,read_enabled,last_sync_at,credential_ciphertext")
        .eq("user_id", userId),
      supabase.from("positions").select("*").eq("user_id", userId).eq("status", "open"),
      supabase.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle(),
    ]);

    const { decryptJSON } = await import("@/lib/crypto.server");
    const { createConnector } = await import("@/lib/connectors/factory.server");

    const connections = await Promise.all((connsR.data ?? []).map(async (c) => {
      let balances: { currency: string; total: number; available: number }[] = [];
      let positions: { symbol: string; qty: number; avgEntry: number }[] = [];
      let liveError: string | null = null;
      let synced = false;
      try {
        if (c.status === "connected") {
          const creds = c.credential_ciphertext
            ? (decryptJSON(c.credential_ciphertext) as Record<string, string>)
            : {};
          const conn = createConnector(c.connector_id, creds);
          [balances, positions] = await Promise.all([
            conn.getBalances().catch(() => []),
            conn.getPositions().catch(() => []),
          ]);
          synced = true;
          // Best-effort sync bookkeeping.
          await supabase.from("exchange_connections")
            .update({ last_sync_at: new Date().toISOString(), health: "healthy" })
            .eq("id", c.id);
        }
      } catch (e) {
        liveError = e instanceof Error ? e.message : String(e);
        await supabase.from("exchange_connections")
          .update({ health: "degraded" }).eq("id", c.id);
      }
      const totalUsd = balances.reduce(
        (s, b) => s + (b.currency === "USD" || b.currency === "USDT" ? b.total : 0), 0);
      return {
        id: c.id, label: c.label, connectorId: c.connector_id,
        status: c.status, health: liveError ? "degraded" : c.health,
        readEnabled: c.read_enabled, tradingEnabled: c.trading_enabled,
        lastSyncAt: c.last_sync_at, synced, liveError,
        balances, positions, cashUsd: totalUsd,
      };
    }));

    const openPositions = posR.data ?? [];
    const paperCash = Number(acctR.data?.cash_balance ?? 0);
    const exposure = openPositions.reduce(
      (s, p) => s + Number(p.qty) * Number(p.avg_entry), 0);

    return {
      connections,
      paperAccount: {
        cashBalance: paperCash,
        openPositions: openPositions.length,
        marketExposure: exposure,
        exposurePctOfEquity: paperCash + exposure > 0 ? exposure / (paperCash + exposure) : 0,
      },
      generatedAt: new Date().toISOString(),
    };
  });

// ---------- AI Readiness Score ----------

type Bucket = { label: string; score: number; weight: number; detail: string };

export const getReadinessScore = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const [backtestsR, shadowR, signalsR, strategiesR] = await Promise.all([
      supabase.from("backtest_runs")
        .select("sharpe_ratio,sortino_ratio,max_drawdown,win_rate,total_trades,profit_factor,run_type,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      supabase.from("shadow_trades")
        .select("pnl,pnl_pct,confidence,status,entry_ts,close_ts,market_regime")
        .eq("user_id", userId).limit(500),
      supabase.from("signals")
        .select("confidence,outcome_status,outcome_pnl_pct")
        .eq("user_id", userId).not("outcome_status", "is", null).limit(500),
      supabase.from("strategies").select("health_status,is_active").eq("user_id", userId),
    ]);

    const buckets: Bucket[] = [];

    // 1. Backtest quality — best Sharpe of any run.
    const bts = backtestsR.data ?? [];
    const bestSharpe = bts.reduce((m, r) => Math.max(m, Number(r.sharpe_ratio ?? 0)), 0);
    const btTrades = bts.reduce((s, r) => s + Number(r.total_trades ?? 0), 0);
    const btScore = bts.length === 0 ? 0 : Math.max(0, Math.min(1, bestSharpe / 2));
    buckets.push({
      label: "Backtest quality",
      score: btScore, weight: 0.18,
      detail: bts.length === 0
        ? "Run a backtest in the Strategy Lab."
        : `Best Sharpe ${bestSharpe.toFixed(2)} across ${bts.length} run${bts.length===1?"":"s"} (${btTrades} trades).`,
    });

    // 2. Walk-forward results — must have at least one walk-forward run.
    const wf = bts.filter(r => r.run_type === "walk_forward");
    const wfSharpe = wf.reduce((m, r) => Math.max(m, Number(r.sharpe_ratio ?? 0)), 0);
    const wfScore = wf.length === 0 ? 0 : Math.max(0, Math.min(1, wfSharpe / 1.5));
    buckets.push({
      label: "Walk-forward validation",
      score: wfScore, weight: 0.15,
      detail: wf.length === 0
        ? "No walk-forward run yet — required to detect overfitting."
        : `${wf.length} walk-forward run${wf.length===1?"":"s"}, best out-of-sample Sharpe ${wfSharpe.toFixed(2)}.`,
    });

    // 3. Shadow trading results — need enough closed shadow trades.
    const shadow = shadowR.data ?? [];
    const closedShadow = shadow.filter(t => t.status === "closed");
    const wins = closedShadow.filter(t => Number(t.pnl ?? 0) > 0).length;
    const winRate = closedShadow.length ? wins / closedShadow.length : 0;
    const sampleFactor = Math.min(1, closedShadow.length / 30); // 30 trades = full weight
    const shadowScore = winRate * sampleFactor;
    buckets.push({
      label: "Shadow trading",
      score: shadowScore, weight: 0.25,
      detail: closedShadow.length === 0
        ? "Record and evaluate shadow trades over 30–60 days."
        : `${closedShadow.length} closed shadow trade${closedShadow.length===1?"":"s"}, ${(winRate*100).toFixed(0)}% win rate.`,
    });

    // 4. Drawdown control — best (lowest magnitude) DD across runs.
    const dds = bts.map(r => Math.abs(Number(r.max_drawdown ?? 0))).filter(x => x > 0);
    const bestDd = dds.length ? Math.min(...dds) : 1;
    // 5% DD -> 1.0; 30%+ -> 0
    const ddScore = dds.length === 0 ? 0 : Math.max(0, Math.min(1, (0.30 - bestDd) / 0.25));
    buckets.push({
      label: "Drawdown control",
      score: ddScore, weight: 0.12,
      detail: dds.length === 0
        ? "No drawdown data — run a backtest."
        : `Best max drawdown ${(bestDd*100).toFixed(1)}%.`,
    });

    // 5. Confidence calibration — high-confidence signals should beat low-confidence.
    const resolved = (signalsR.data ?? []).filter(s => s.outcome_status === "hit_tp" || s.outcome_status === "hit_sl");
    const hi = resolved.filter(s => Number(s.confidence) >= 0.7);
    const lo = resolved.filter(s => Number(s.confidence) < 0.7);
    const hiWr = hi.length ? hi.filter(s => s.outcome_status === "hit_tp").length / hi.length : 0;
    const loWr = lo.length ? lo.filter(s => s.outcome_status === "hit_tp").length / lo.length : 0;
    // Positive skew = calibrated. Gap of +25pts -> 1.0
    const calibScore = resolved.length < 10 ? 0 : Math.max(0, Math.min(1, (hiWr - loWr) / 0.25));
    buckets.push({
      label: "Confidence calibration",
      score: calibScore, weight: 0.15,
      detail: resolved.length < 10
        ? "Need at least 10 evaluated signals."
        : `High-conf ${(hiWr*100).toFixed(0)}% vs low-conf ${(loWr*100).toFixed(0)}% (n=${resolved.length}).`,
    });

    // 6. Strategy health — % of active strategies in 'healthy' state.
    const strats = strategiesR.data ?? [];
    const active = strats.filter(s => s.is_active);
    const healthy = active.filter(s => s.health_status === "healthy").length;
    const healthScore = active.length === 0 ? 0 : healthy / active.length;
    buckets.push({
      label: "Strategy health",
      score: healthScore, weight: 0.15,
      detail: active.length === 0
        ? "No active strategies."
        : `${healthy}/${active.length} active strategies healthy.`,
    });

    const totalWeight = buckets.reduce((s, b) => s + b.weight, 0);
    const overall = buckets.reduce((s, b) => s + b.score * b.weight, 0) / totalWeight;
    const score100 = Math.round(overall * 100);

    let tier: "not_ready" | "testing" | "almost_ready" | "ready_for_assisted";
    let tierLabel: string;
    if (score100 < 30) { tier = "not_ready"; tierLabel = "Not Ready"; }
    else if (score100 < 55) { tier = "testing"; tierLabel = "Testing"; }
    else if (score100 < 75) { tier = "almost_ready"; tierLabel = "Almost Ready"; }
    else { tier = "ready_for_assisted"; tierLabel = "Ready for Assisted Trading"; }

    return { score: score100, tier, tierLabel, buckets };
  });

// ---------- Shadow analytics (regime + asset breakdown) ----------

export const getShadowAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("shadow_trades")
      .select("symbol,pnl,pnl_pct,status,market_regime,entry_price,close_price,confidence")
      .eq("user_id", context.userId).limit(500);
    const rows = data ?? [];
    const closed = rows.filter(r => r.status === "closed");

    function groupBy<K extends string>(key: (r: typeof closed[number]) => K) {
      const m = new Map<K, { n: number; wins: number; pnl: number; pnlPct: number }>();
      for (const r of closed) {
        const k = key(r);
        const cur = m.get(k) ?? { n: 0, wins: 0, pnl: 0, pnlPct: 0 };
        cur.n += 1;
        if (Number(r.pnl ?? 0) > 0) cur.wins += 1;
        cur.pnl += Number(r.pnl ?? 0);
        cur.pnlPct += Number(r.pnl_pct ?? 0);
        m.set(k, cur);
      }
      return [...m.entries()].map(([k, v]) => ({
        key: k, n: v.n, winRate: v.wins / v.n,
        totalPnl: v.pnl, avgPnlPct: v.pnlPct / v.n,
      })).sort((a, b) => b.n - a.n);
    }

    const byRegime = groupBy(r => (r.market_regime ?? "unknown"));
    const byAsset = groupBy(r => r.symbol);

    // Buy-and-hold benchmark: avg % change per symbol from entry to close ts.
    const hold = closed.map(r => {
      const entry = Number(r.entry_price); const exit = Number(r.close_price ?? entry);
      return entry > 0 ? (exit - entry) / entry : 0;
    });
    const holdAvg = hold.length ? hold.reduce((a, b) => a + b, 0) / hold.length : 0;
    const stratAvg = closed.length ? closed.reduce((a, r) => a + Number(r.pnl_pct ?? 0), 0) / closed.length : 0;

    return {
      byRegime, byAsset,
      benchmark: { strategyAvgPct: stratAvg, buyHoldAvgPct: holdAvg, edgePct: stratAvg - holdAvg, n: closed.length },
    };
  });
