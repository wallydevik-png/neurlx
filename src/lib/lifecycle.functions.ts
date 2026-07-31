import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listStrategyLifecycle = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [{ data: strategies }, { data: events }] = await Promise.all([
      supabase.from("strategies").select("*").eq("user_id", userId).order("score", { ascending: false }),
      supabase.from("strategy_lifecycle_events").select("*").eq("user_id", userId)
        .order("created_at", { ascending: false }).limit(25),
    ]);
    const ids = (strategies ?? []).map(s => s.id);
    const { data: allRuns } = await supabase.from("strategy_validation_runs")
      .select("*").eq("user_id", userId)
      .in("strategy_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
      .order("created_at", { ascending: false }).limit(200);
    const seen = new Set<string>();
    const runs = (allRuns ?? []).filter(r => {
      if (seen.has(r.strategy_id)) return false;
      seen.add(r.strategy_id); return true;
    });
    const { data: regimes } = await supabase.from("strategy_regime_stats")
      .select("*").eq("user_id", userId);
    const { data: models } = await supabase.from("model_versions")
      .select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(10);
    return {
      strategies: strategies ?? [],
      events: events ?? [],
      runs,
      regimes: regimes ?? [],
      models: models ?? [],
    };
  });

export const evaluateLifecycleFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { evaluateAllStrategies } = await import("@/lib/lifecycle/engine.server");
    const results = await evaluateAllStrategies(context.supabase, context.userId);
    return {
      evaluated: results.length,
      changed: results.filter(r => r.changed).map(r => ({ name: r.name, from: r.previousState, to: r.state, reason: r.reason })),
    };
  });

export const setStrategyState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; state: "shadow" | "paper" | "live" | "disabled"; reason?: string }) => d)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: cur } = await supabase.from("strategies").select("*")
      .eq("id", data.id).eq("user_id", userId).maybeSingle();
    if (!cur) throw new Error("Strategy not found");
    if (data.state === "live" && Number(cur.score ?? 0) < 80) {
      throw new Error("Manual promotion to LIVE is blocked — score must be ≥80.");
    }
    await supabase.from("strategies").update({
      lifecycle_state: data.state,
      state_reason: data.reason ?? "manual_override",
      state_changed_at: new Date().toISOString(),
      is_active: data.state === "live" || data.state === "paper",
      allocation_risk_pct: data.state === "live" ? Number(cur.allocation_risk_pct ?? 0) : 0,
    }).eq("id", data.id).eq("user_id", userId);
    await supabase.from("strategy_lifecycle_events").insert({
      user_id: userId, strategy_id: data.id,
      from_state: String(cur.lifecycle_state ?? "shadow"), to_state: data.state,
      reason: data.reason ?? "manual_override", metrics: {},
    });
    return { ok: true };
  });

export const compareStrategiesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { championId: string; challengerId: string }) => d)
  .handler(async ({ data, context }) => {
    const { compareCandidates } = await import("@/lib/lifecycle/engine.server");
    return compareCandidates(context.supabase, context.userId, data.championId, data.challengerId);
  });

export const retrainModelsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { force?: boolean }) => d)
  .handler(async ({ data, context }) => {
    const { runWeekendRetraining } = await import("@/lib/lifecycle/engine.server");
    return runWeekendRetraining(context.supabase, context.userId, data.force === true);
  });
