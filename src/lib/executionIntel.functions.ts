import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Execution Intelligence dashboard: decisions, grades, sessions, model versions. */
export const getExecutionIntel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadExecutionIntel } = await import("@/lib/execution/executionIntel.server");
    return loadExecutionIntel(context.supabase, context.userId);
  });

/** Runs the full execution gate for one symbol without placing anything. */
export const inspectExecution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { symbol: string; side: "buy" | "sell" }) => d)
  .handler(async ({ data, context }) => {
    const { evaluateExecution } = await import("@/lib/execution/executionIntel.server");
    return evaluateExecution(context.supabase, context.userId, {
      symbol: data.symbol, side: data.side, persist: false,
    });
  });

/** Forces an entry-model re-optimisation + significance test. */
export const runExecutionLearningNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { force?: boolean } | undefined) => d ?? {})
  .handler(async ({ data, context }) => {
    const { runExecutionLearning } = await import("@/lib/execution/executionIntel.server");
    return runExecutionLearning(context.supabase, context.userId, { force: data.force });
  });

/** Execution Intelligence user controls. */
export const updateExecutionSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    enabled?: boolean; minConfidence?: number; sessionFilterEnabled?: boolean;
  }) => d)
  .handler(async ({ data, context }) => {
    const patch: {
      exec_intel_enabled?: boolean; exec_min_confidence?: number;
      exec_session_filter_enabled?: boolean;
    } = {};
    if (data.enabled != null) patch.exec_intel_enabled = data.enabled;
    if (data.sessionFilterEnabled != null) patch.exec_session_filter_enabled = data.sessionFilterEnabled;
    if (data.minConfidence != null) {
      patch.exec_min_confidence = Math.min(0.99, Math.max(0.4, Number(data.minConfidence)));
    }
    if (Object.keys(patch).length) {
      await context.supabase.from("automation_settings").update(patch)
        .eq("user_id", context.userId);
    }
    return { ok: true };
  });

/**
 * Manual stop/target override on an open position. The AI's calculated levels
 * stay visible on the Live Desk; switching back to "ai" hands control back to
 * the profit-protection engine.
 */
export const setPositionTargets = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: {
    positionId: string; mode: "ai" | "manual";
    stopLoss?: number | null; takeProfit?: number | null;
  }) => d)
  .handler(async ({ data, context }) => {
    const { data: pos } = await context.supabase.from("positions")
      .select("id,side,avg_entry,status,stop_loss,take_profit")
      .eq("id", data.positionId).eq("user_id", context.userId).maybeSingle();
    if (!pos || pos.status !== "open") throw new Error("Position is not open");

    const patch: { sl_tp_mode: string; stop_loss?: number; take_profit?: number } = {
      sl_tp_mode: data.mode,
    };
    if (data.mode === "manual") {
      const dir = pos.side === "long" ? 1 : -1;
      const entry = Number(pos.avg_entry);
      if (data.stopLoss != null) {
        if (!(data.stopLoss > 0)) throw new Error("Stop loss must be greater than zero");
        if (dir === 1 && data.stopLoss >= entry * 1.5) throw new Error("Stop is implausibly far above entry");
        patch.stop_loss = data.stopLoss;
      }
      if (data.takeProfit != null) {
        if (!(data.takeProfit > 0)) throw new Error("Take profit must be greater than zero");
        patch.take_profit = data.takeProfit;
      }
    }
    await context.supabase.from("positions").update(patch).eq("id", data.positionId);
    await context.supabase.from("execution_log").insert({
      user_id: context.userId, position_id: data.positionId,
      event: data.mode === "manual" ? "position.manual_targets" : "position.ai_targets",
      severity: "info",
      message: data.mode === "manual"
        ? `Manual stop ${patch.stop_loss ?? pos.stop_loss} / target ${patch.take_profit ?? pos.take_profit}`
        : "Stop and target handed back to the AI profit-protection engine",
      payload: { ...patch, previous: { stop_loss: pos.stop_loss, take_profit: pos.take_profit } },
    });
    return { ok: true };
  });
