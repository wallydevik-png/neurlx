// AI Portfolio Manager, Optimizer, Multi-strategy, Shadow-mode, Decision Center
// server functions. Client-safe module.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = <T,>(v: T) => v as any;

const RiskProfileSchema = z.enum(["conservative", "balanced", "aggressive"]);

// ---------- AI Portfolio Manager / Decision Center ----------

export const getPortfolioRecommendation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [acctR, posR, settingsR, strategiesR] = await Promise.all([
      supabase.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("positions").select("*").eq("user_id", userId).eq("status", "open"),
      supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("strategies").select("id,name,strategy_type,is_active,capital_allocation_pct,health_status")
        .eq("user_id", userId),
    ]);
    const profile = (settingsR.data?.risk_level ?? "balanced") as "conservative" | "balanced" | "aggressive";
    const allowed = (settingsR.data?.allowed_assets ?? []) as string[];
    const cash = Number(acctR.data?.cash_balance ?? 0);
    const holdings = (posR.data ?? []).map(p => ({
      symbol: p.symbol, qty: Number(p.qty),
      avgEntry: Number(p.avg_entry), side: p.side as "long" | "short",
    }));

    const { buildPortfolioRecommendation } = await import("@/lib/portfolio/manager.server");
    const rec = await buildPortfolioRecommendation(supabase, {
      cash, holdings, profile, allowedAssets: allowed,
    });

    return {
      profile,
      killSwitch: settingsR.data?.kill_switch_active ?? false,
      mode: settingsR.data?.mode ?? "manual",
      activeStrategies: (strategiesR.data ?? []).filter(s => s.is_active),
      recommendation: rec,
    };
  });

// ---------- Optimizer ----------

const OptimizeSchema = z.object({
  symbol: z.string().min(1),
  interval: z.enum(["5m", "15m", "1h", "4h", "1d"]).default("15m"),
  bars: z.number().int().min(120).max(1000).default(400),
  strategyId: z.string().uuid().optional(),
  grid: z.object({
    minConfidence: z.array(z.number()).optional(),
    riskPerTradePct: z.array(z.number()).optional(),
    maxBarsInTrade: z.array(z.number()).optional(),
  }),
});

export const runOptimizationFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => OptimizeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { runOptimization } = await import("@/lib/portfolio/optimizer.server");
    const result = await runOptimization(context.supabase, {
      symbol: data.symbol, interval: data.interval, bars: data.bars,
    }, data.grid);

    const { data: row, error } = await context.supabase.from("optimization_runs").insert(asJson({
      user_id: context.userId,
      strategy_id: data.strategyId ?? null,
      symbol: data.symbol, interval: data.interval, bars: data.bars,
      param_grid: data.grid,
      results: result.candidates,
      best_params: result.best.params,
      best_metrics: result.best.metrics,
    })).select().single();
    if (error) throw error;
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "optimizer.run", entity: "optimization_runs",
      entity_id: row.id, payload: { symbol: data.symbol, combos: result.candidates.length },
    });
    return { id: row.id, ...result };
  });

export const listOptimizationRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("optimization_runs")
      .select("id,symbol,interval,bars,best_params,best_metrics,created_at,strategy_id")
      .eq("user_id", context.userId).order("created_at", { ascending: false }).limit(30);
    return data ?? [];
  });

// ---------- Multi-strategy ----------

export const listStrategiesWithHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("strategies").select("*")
      .eq("user_id", context.userId).order("created_at", { ascending: false });
    return data ?? [];
  });

const StrategyUpdateSchema = z.object({
  id: z.string().uuid(),
  isActive: z.boolean().optional(),
  strategyType: z.enum(["trend_following", "momentum", "breakout", "mean_reversion", "volatility"]).optional(),
  capitalAllocationPct: z.number().min(0).max(100).optional(),
});

export const updateStrategy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => StrategyUpdateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.isActive !== undefined) patch.is_active = data.isActive;
    if (data.strategyType) patch.strategy_type = data.strategyType;
    if (data.capitalAllocationPct !== undefined) patch.capital_allocation_pct = data.capitalAllocationPct;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await context.supabase.from("strategies").update(patch as any)
      .eq("id", data.id).eq("user_id", context.userId);
    if (error) throw error;
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "strategy.update", entity: "strategies",
      entity_id: data.id, payload: patch as Record<string, string | number | boolean | null>,
    });
    return { ok: true };
  });

export const evaluateStrategyHealthFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { evaluateStrategyHealth } = await import("@/lib/portfolio/health.server");
    return await evaluateStrategyHealth(context.supabase, context.userId, data.id);
  });

// ---------- Shadow Mode ----------

const ShadowRecordSchema = z.object({
  symbol: z.string().optional(),
  strategyId: z.string().uuid().optional(),
});

// Record what the AI *would* have done for the top opportunity without executing.
export const recordShadowFromSignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ShadowRecordSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { analyzeSymbol, scanMarket } = await import("@/lib/trading/aiEngine.server");
    const { listSupportedSymbols } = await import("@/lib/marketdata/service.server");
    const { data: settings } = await context.supabase.from("automation_settings")
      .select("allowed_assets,min_confidence").eq("user_id", context.userId).maybeSingle();
    const universe = data.symbol ? [data.symbol]
      : (settings?.allowed_assets?.length ? settings.allowed_assets : listSupportedSymbols().slice(0, 6));
    const sig = data.symbol
      ? await analyzeSymbol(context.supabase, data.symbol)
      : (await scanMarket(context.supabase, universe)).find(s => s.direction !== "wait");
    if (!sig || sig.direction === "wait") throw new Error("No tradable setup right now.");
    const min = Number(settings?.min_confidence ?? 0.6);
    if (sig.confidence < min) throw new Error(`Signal confidence ${(sig.confidence*100).toFixed(0)}% below your minimum ${(min*100).toFixed(0)}%.`);

    const { data: row, error } = await context.supabase.from("shadow_trades").insert(asJson({
      user_id: context.userId,
      strategy_id: data.strategyId ?? null,
      symbol: sig.symbol, side: sig.side,
      entry_price: sig.entry, stop_loss: sig.stopLoss, take_profit: sig.takeProfit,
      qty: sig.qty, confidence: sig.confidence, market_regime: sig.regime,
      indicators: { ...sig.indicators, reasoning: sig.reasoning, contributions: sig.contributions },
    })).select().single();
    if (error) throw error;
    return row;
  });

export const evaluateShadowTrades = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { fetchLastPrice } = await import("@/lib/marketdata/service.server");
    const { data: open } = await context.supabase.from("shadow_trades").select("*")
      .eq("user_id", context.userId).eq("status", "open").limit(100);
    let closed = 0;
    for (const t of open ?? []) {
      try {
        const price = await fetchLastPrice(t.symbol);
        const dir = t.side === "buy" ? 1 : -1;
        let exit: number | null = null; let reason: string | null = null;
        if (dir * (price - Number(t.take_profit)) >= 0) { exit = Number(t.take_profit); reason = "take_profit"; }
        else if (dir * (Number(t.stop_loss) - price) >= 0) { exit = Number(t.stop_loss); reason = "stop_loss"; }
        // 3-day time exit
        else if (Date.now() - new Date(t.entry_ts).getTime() > 3 * 24 * 3600 * 1000) { exit = price; reason = "time_exit"; }
        if (exit !== null) {
          const pnl = (exit - Number(t.entry_price)) * dir * Number(t.qty);
          const pnlPct = ((exit - Number(t.entry_price)) / Number(t.entry_price)) * dir;
          await context.supabase.from("shadow_trades").update({
            status: "closed", close_ts: new Date().toISOString(),
            close_price: exit, pnl, pnl_pct: pnlPct, exit_reason: reason,
          }).eq("id", t.id);
          closed++;
        }
      } catch { /* skip */ }
    }
    return { closed };
  });

export const listShadowTrades = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("shadow_trades").select("*")
      .eq("user_id", context.userId).order("entry_ts", { ascending: false }).limit(100);
    const list = data ?? [];
    const closed = list.filter(t => t.status === "closed");
    const wins = closed.filter(t => Number(t.pnl) > 0).length;
    return {
      trades: list,
      stats: {
        total: list.length, open: list.length - closed.length, closed: closed.length,
        winRate: closed.length ? wins / closed.length : 0,
        totalPnl: closed.reduce((s, t) => s + Number(t.pnl ?? 0), 0),
        avgPnlPct: closed.length ? closed.reduce((s, t) => s + Number(t.pnl_pct ?? 0), 0) / closed.length : 0,
      },
    };
  });
