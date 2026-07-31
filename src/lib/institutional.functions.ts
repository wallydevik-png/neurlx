import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Capital-protection snapshot: drawdown budgets, risk state, position caps. */
export const getRiskPolicy = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadPolicy } = await import("@/lib/risk/policy.server");
    return loadPolicy(context.supabase, context.userId);
  });

/** Runs the full institutional entry gate for one symbol (transparency view). */
export const inspectEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { symbol: string; side: "buy" | "sell" }) => d)
  .handler(async ({ data, context }) => {
    const { evaluateEntry } = await import("@/lib/trading/entryFilters.server");
    const { data: s } = await context.supabase
      .from("automation_settings").select("*").eq("user_id", context.userId).maybeSingle();
    return evaluateEntry(context.supabase, data.symbol, data.side, {
      minConfidence: Math.max(Number(s?.autonomous_min_confidence ?? 0.9), 0.9),
      minRR: Number(s?.min_risk_reward ?? 2),
      maxRR: Number(s?.max_risk_reward ?? 4),
      maxSpreadBps: Number(s?.max_spread_bps ?? 30),
      requireMtf: s?.mtf_confirmation_required !== false,
      newsFilterEnabled: s?.news_filter_enabled !== false,
    });
  });

/** Self-learning review — auto-runs every 100 closed trades, or on demand. */
export const runLearningReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { force?: boolean } | undefined) => d ?? {})
  .handler(async ({ data, context }) => {
    const { runLearningEvaluation } = await import("@/lib/learning/evaluator.server");
    return runLearningEvaluation(context.supabase, context.userId, { force: data.force });
  });

/** Strategy weights + the most recent learning evaluations. */
export const getLearningState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getStrategyWeights, EVALUATION_INTERVAL } = await import("@/lib/learning/evaluator.server");
    const [weights, evals, closed] = await Promise.all([
      getStrategyWeights(context.supabase, context.userId),
      context.supabase.from("learning_evaluations").select("*")
        .eq("user_id", context.userId).order("created_at", { ascending: false }).limit(5),
      context.supabase.from("positions").select("id", { count: "exact", head: true })
        .eq("user_id", context.userId).eq("status", "closed"),
    ]);
    const total = closed.count ?? 0;
    const last = Number(evals.data?.[0]?.trades_evaluated ?? 0);
    return {
      weights,
      evaluations: evals.data ?? [],
      closedTrades: total,
      tradesUntilReview: Math.max(0, EVALUATION_INTERVAL - (total - last)),
      interval: EVALUATION_INTERVAL,
    };
  });

/** Institutional risk controls the user can tune. */
export const updateInstitutionalSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    riskPerTradePct?: number;
    maxDailyDrawdownPct?: number;
    maxWeeklyDrawdownPct?: number;
    maxAccountDrawdownPct?: number;
    maxSpreadBps?: number;
    minRiskReward?: number;
    maxRiskReward?: number;
    newsFilterEnabled?: boolean;
    mtfConfirmationRequired?: boolean;
    maxCorrelatedRiskPct?: number;
    minConfidence?: number;
  }) => d)
  .handler(async ({ data, context }) => {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    const patch: {
      risk_per_trade_pct?: number; max_daily_drawdown_pct?: number;
      max_weekly_drawdown_pct?: number; max_account_drawdown_pct?: number;
      max_spread_bps?: number; min_risk_reward?: number; max_risk_reward?: number;
      max_correlated_risk_pct?: number; autonomous_min_confidence?: number;
      news_filter_enabled?: boolean; mtf_confirmation_required?: boolean;
    } = {};
    if (data.riskPerTradePct != null) patch.risk_per_trade_pct = clamp(data.riskPerTradePct, 0.0025, 0.01);
    if (data.maxDailyDrawdownPct != null) patch.max_daily_drawdown_pct = clamp(data.maxDailyDrawdownPct, 0.5, 10);
    if (data.maxWeeklyDrawdownPct != null) patch.max_weekly_drawdown_pct = clamp(data.maxWeeklyDrawdownPct, 1, 20);
    if (data.maxAccountDrawdownPct != null) patch.max_account_drawdown_pct = clamp(data.maxAccountDrawdownPct, 3, 40);
    if (data.maxSpreadBps != null) patch.max_spread_bps = clamp(data.maxSpreadBps, 1, 200);
    if (data.minRiskReward != null) patch.min_risk_reward = clamp(data.minRiskReward, 1, 5);
    if (data.maxRiskReward != null) patch.max_risk_reward = clamp(data.maxRiskReward, 2, 10);
    if (data.maxCorrelatedRiskPct != null) patch.max_correlated_risk_pct = clamp(data.maxCorrelatedRiskPct, 0.5, 10);
    if (data.minConfidence != null) patch.autonomous_min_confidence = clamp(data.minConfidence, 0.6, 0.99);
    if (data.newsFilterEnabled != null) patch.news_filter_enabled = data.newsFilterEnabled;
    if (data.mtfConfirmationRequired != null) patch.mtf_confirmation_required = data.mtfConfirmationRequired;
    if (Object.keys(patch).length) {
      await context.supabase.from("automation_settings").update(patch).eq("user_id", context.userId);
    }
    return { ok: true };
  });

/** Clears a recovery pause / drawdown lock after the user reviews the losses. */
export const resetRecoveryPause = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("automation_settings")
      .update({ recovery_pause_until: null }).eq("user_id", context.userId);
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "risk.recovery_pause_cleared", entity: "automation_settings",
    });
    return { ok: true };
  });
