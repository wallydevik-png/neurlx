import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Full live desk snapshot: account summary, open positions, closed trades. */
export const getLiveDesk = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadLiveDesk } = await import("@/lib/liveDesk/desk.server");
    return loadLiveDesk(context.supabase, context.userId);
  });

/** Per-strategy performance analytics computed from real closed broker trades. */
export const getStrategyAnalytics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadLiveDesk, analyzeTrades } = await import("@/lib/liveDesk/desk.server");
    const snap = await loadLiveDesk(context.supabase, context.userId);
    return {
      strategies: analyzeTrades(snap.closed.map(t => ({
        strategy: t.strategy, netProfit: t.netProfit, holdingSeconds: t.holdingSeconds,
      }))),
      overall: analyzeTrades(snap.closed.map(t => ({
        strategy: "All strategies", netProfit: t.netProfit, holdingSeconds: t.holdingSeconds,
      })))[0] ?? null,
    };
  });

/** Portfolio view: exposure, equity curve, cumulative return. */
export const getPortfolioOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadLiveDesk, buildPortfolio } = await import("@/lib/liveDesk/desk.server");
    const snap = await loadLiveDesk(context.supabase, context.userId);
    return { ...buildPortfolio(snap), hasLiveAccounts: snap.hasLiveAccounts };
  });

/** Margin + daily-target risk controls. */
export const updateMarginSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { minFreeMarginPct?: number; dailyProfitTarget?: number }) => d)
  .handler(async ({ data, context }) => {
    const patch: { min_free_margin_pct?: number; daily_profit_target?: number } = {};
    if (data.minFreeMarginPct != null) {
      patch.min_free_margin_pct = Math.min(90, Math.max(0, Number(data.minFreeMarginPct)));
    }
    if (data.dailyProfitTarget != null) {
      patch.daily_profit_target = Math.max(0, Number(data.dailyProfitTarget));
    }
    if (Object.keys(patch).length) {
      await context.supabase.from("automation_settings").update(patch)
        .eq("user_id", context.userId);
    }
    return { ok: true };
  });

/** Fires daily profit-target / loss-limit notifications from live realized P/L. */
export const checkDailyTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { evaluateDailyTargets } = await import("@/lib/liveDesk/targets.server");
    return evaluateDailyTargets(context.supabase, context.userId);
  });
