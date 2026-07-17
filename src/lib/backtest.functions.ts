// Backtesting + strategy lab server functions. Client-safe module.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const IntervalSchema = z.enum(["5m", "15m", "1h", "4h", "1d"]);

const RunSchema = z.object({
  symbol: z.string().min(1),
  interval: IntervalSchema.default("15m"),
  bars: z.number().int().min(120).max(1000).default(500),
  minConfidence: z.number().min(0).max(1).default(0.55),
  feeBps: z.number().min(0).max(200).default(10),
  slippageBps: z.number().min(0).max(200).default(5),
  riskPerTradePct: z.number().min(0.001).max(0.1).default(0.01),
  maxBarsInTrade: z.number().int().min(3).max(200).default(40),
  startingCapital: z.number().min(100).max(10_000_000).default(10_000),
  strategyId: z.string().uuid().optional(),
  label: z.string().max(80).optional(),
});

export const runBacktestFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RunSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { runBacktest } = await import("@/lib/backtest/engine.server");
    const result = await runBacktest(context.supabase, data);
    const { data: run, error } = await context.supabase.from("backtest_runs").insert({
      user_id: context.userId,
      strategy_id: data.strategyId ?? null,
      kind: "single",
      label: data.label ?? `${data.symbol} · ${data.interval}`,
      symbol: data.symbol,
      interval: data.interval,
      from_ts: new Date(result.fromTs).toISOString(),
      to_ts: new Date(result.toTs).toISOString(),
      params: result.params as unknown as Record<string, unknown>,
      metrics: result.metrics as unknown as Record<string, unknown>,
      equity_curve: result.equity as unknown as Record<string, unknown>[],
    }).select().single();
    if (error) throw error;
    if (result.trades.length) {
      await context.supabase.from("backtest_trades").insert(
        result.trades.map(t => ({
          run_id: run.id, user_id: context.userId,
          symbol: t.symbol, side: t.side,
          entry_ts: new Date(t.entryTs).toISOString(), entry_price: t.entryPrice,
          exit_ts: new Date(t.exitTs).toISOString(), exit_price: t.exitPrice,
          qty: t.qty, pnl: t.pnl, pnl_pct: t.pnlPct,
          exit_reason: t.exitReason, confidence: t.confidence,
          market_regime: t.regime, indicators: t.indicators,
        })),
      );
    }
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "backtest.run", entity: "backtest_runs",
      entity_id: run.id, payload: { symbol: data.symbol, interval: data.interval },
    });
    return { runId: run.id, metrics: result.metrics as unknown as Record<string, unknown>, trades: result.trades.length };
  });

export const runWalkForwardFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => RunSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { runWalkForward } = await import("@/lib/backtest/engine.server");
    const { train, validation, oos } = await runWalkForward(context.supabase, data);

    const { data: parent, error: pErr } = await context.supabase.from("backtest_runs").insert({
      user_id: context.userId,
      strategy_id: data.strategyId ?? null,
      kind: "walkforward_train",
      label: data.label ?? `Walk-forward · ${data.symbol}`,
      symbol: data.symbol, interval: data.interval,
      from_ts: new Date(train.fromTs).toISOString(), to_ts: new Date(train.toTs).toISOString(),
      params: train.params, metrics: train.metrics, equity_curve: train.equity,
    }).select().single();
    if (pErr) throw pErr;

    async function insertChild(kind: string, r: typeof validation) {
      const { data: row, error } = await context.supabase.from("backtest_runs").insert({
        user_id: context.userId, parent_run_id: parent.id, strategy_id: data.strategyId ?? null,
        kind, label: `${kind.replace('walkforward_','')} · ${data.symbol}`,
        symbol: data.symbol, interval: data.interval,
        from_ts: new Date(r.fromTs).toISOString(), to_ts: new Date(r.toTs).toISOString(),
        params: r.params, metrics: r.metrics, equity_curve: r.equity,
      }).select().single();
      if (error) throw error;
      if (r.trades.length) {
        await context.supabase.from("backtest_trades").insert(
          r.trades.map(t => ({
            run_id: row.id, user_id: context.userId,
            symbol: t.symbol, side: t.side,
            entry_ts: new Date(t.entryTs).toISOString(), entry_price: t.entryPrice,
            exit_ts: new Date(t.exitTs).toISOString(), exit_price: t.exitPrice,
            qty: t.qty, pnl: t.pnl, pnl_pct: t.pnlPct,
            exit_reason: t.exitReason, confidence: t.confidence,
            market_regime: t.regime, indicators: t.indicators,
          })),
        );
      }
      return row.id;
    }
    // Save train's trades on the parent too
    if (train.trades.length) {
      await context.supabase.from("backtest_trades").insert(
        train.trades.map(t => ({
          run_id: parent.id, user_id: context.userId,
          symbol: t.symbol, side: t.side,
          entry_ts: new Date(t.entryTs).toISOString(), entry_price: t.entryPrice,
          exit_ts: new Date(t.exitTs).toISOString(), exit_price: t.exitPrice,
          qty: t.qty, pnl: t.pnl, pnl_pct: t.pnlPct,
          exit_reason: t.exitReason, confidence: t.confidence,
          market_regime: t.regime, indicators: t.indicators,
        })),
      );
    }
    await insertChild("walkforward_validation", validation);
    await insertChild("walkforward_oos", oos);

    return { runId: parent.id, train: train.metrics, validation: validation.metrics, oos: oos.metrics };
  });

export const listBacktests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("backtest_runs")
      .select("id,label,symbol,interval,kind,parent_run_id,metrics,from_ts,to_ts,created_at")
      .eq("user_id", context.userId).is("parent_run_id", null)
      .order("created_at", { ascending: false }).limit(50);
    return data ?? [];
  });

export const getBacktest = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const [runRes, tradesRes, childrenRes] = await Promise.all([
      context.supabase.from("backtest_runs").select("*").eq("id", data.id).eq("user_id", context.userId).maybeSingle(),
      context.supabase.from("backtest_trades").select("*").eq("run_id", data.id).eq("user_id", context.userId).order("entry_ts"),
      context.supabase.from("backtest_runs").select("id,kind,label,metrics,equity_curve,from_ts,to_ts").eq("parent_run_id", data.id).eq("user_id", context.userId),
    ]);
    return { run: runRes.data, trades: tradesRes.data ?? [], children: childrenRes.data ?? [] };
  });

const SaveStrategySchema = z.object({
  name: z.string().min(1).max(80),
  symbol: z.string().min(1),
  interval: IntervalSchema,
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  notes: z.string().max(500).optional(),
});
export const saveStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SaveStrategySchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase.from("strategies").insert({
      user_id: context.userId, name: data.name, symbol: data.symbol,
      interval: data.interval, params: data.params, notes: data.notes ?? null,
    }).select().single();
    if (error) throw error;
    return row;
  });

export const listStrategies = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("strategies").select("*")
      .eq("user_id", context.userId).order("created_at", { ascending: false });
    return data ?? [];
  });

export const deleteStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase.from("strategies").delete().eq("id", data.id).eq("user_id", context.userId);
    return { ok: true };
  });

// Signal accuracy tracking: aggregates signals table by confidence bucket,
// market regime, symbol, and time horizon. Only counts signals with an
// evaluated outcome so numbers are honest.
export const getSignalAccuracy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("signals")
      .select("symbol,confidence,market_regime,time_horizon,outcome_status,outcome_pnl_pct")
      .eq("user_id", context.userId)
      .not("outcome_status", "is", null);

    const rows = data ?? [];
    interface Bucket { total: number; wins: number; pnl: number; }
    const empty = (): Bucket => ({ total: 0, wins: 0, pnl: 0 });
    const byConf: Record<string, Bucket> = {
      "50-60": empty(), "60-70": empty(), "70-80": empty(), "80-90": empty(), "90-100": empty(),
    };
    const byRegime: Record<string, Bucket> = {};
    const bySymbol: Record<string, Bucket> = {};
    const byHorizon: Record<string, Bucket> = {};

    const push = (b: Bucket, r: typeof rows[number]) => {
      b.total += 1;
      if (r.outcome_status === "hit_tp" || (Number(r.outcome_pnl_pct) > 0)) b.wins += 1;
      b.pnl += Number(r.outcome_pnl_pct ?? 0);
    };

    for (const r of rows) {
      const c = Math.floor(Number(r.confidence) * 10) * 10;
      const key = c >= 90 ? "90-100" : c >= 80 ? "80-90" : c >= 70 ? "70-80" : c >= 60 ? "60-70" : "50-60";
      push(byConf[key], r);
      const rk = r.market_regime ?? "unknown"; byRegime[rk] ??= empty(); push(byRegime[rk], r);
      const sk = r.symbol; bySymbol[sk] ??= empty(); push(bySymbol[sk], r);
      const hk = r.time_horizon ?? "unknown"; byHorizon[hk] ??= empty(); push(byHorizon[hk], r);
    }

    const finalize = (b: Record<string, Bucket>) =>
      Object.entries(b).map(([k, v]) => ({
        key: k, total: v.total, wins: v.wins,
        winRate: v.total ? v.wins / v.total : 0,
        avgPnlPct: v.total ? v.pnl / v.total : 0,
      }));

    return {
      total: rows.length,
      byConfidence: finalize(byConf),
      byRegime: finalize(byRegime),
      bySymbol: finalize(bySymbol),
      byHorizon: finalize(byHorizon),
    };
  });
