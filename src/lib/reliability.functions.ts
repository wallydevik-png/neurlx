// Slice 11: Institutional Reliability — heartbeats, watchdog, degraded mode, state recovery.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = <T,>(v: T) => v as any;

const STALE_MINUTES = 5;
const CRITICAL_COMPONENTS = ["database", "exchange", "market_data", "ai_engine"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureStatus(supabase: any, userId: string) {
  const { data } = await supabase.from("system_status").select("*").eq("user_id", userId).maybeSingle();
  if (data) return data;
  const { data: created } = await supabase
    .from("system_status").insert({ user_id: userId }).select("*").maybeSingle();
  return created;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logEvent(supabase: any, userId: string, event_type: string, severity: string, message: string, detail: Record<string, unknown> = {}) {
  await supabase.from("recovery_events").insert({ user_id: userId, event_type, severity, message, detail });
}

// ---------- Heartbeat submission ----------

const HeartbeatSchema = z.object({
  component: z.string().min(1).max(64),
  status: z.enum(["ok", "warn", "error"]).default("ok"),
  latency_ms: z.number().int().min(0).max(600000).optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const recordHeartbeat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => HeartbeatSchema.parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    await supabase.from("system_heartbeats").insert({
      user_id: userId,
      component: data.component,
      status: data.status,
      latency_ms: data.latency_ms ?? null,
      detail: data.detail ?? {},
    });
    return { ok: true };
  });

// ---------- Dashboard (health + status + recent events) ----------

export const getReliabilityDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const status = await ensureStatus(supabase, userId);

    // Last heartbeat per component (fetch 500 recent rows, reduce in memory)
    const { data: hbRows } = await supabase
      .from("system_heartbeats")
      .select("component,status,latency_ms,detail,observed_at")
      .eq("user_id", userId)
      .order("observed_at", { ascending: false })
      .limit(500);

    const latestByComp = new Map<string, { component: string; status: string; latency_ms: number | null; observed_at: string; detail: unknown }>();
    for (const r of hbRows ?? []) {
      if (!latestByComp.has(r.component)) latestByComp.set(r.component, r);
    }

    const now = Date.now();
    const components = [...CRITICAL_COMPONENTS, ...Array.from(latestByComp.keys()).filter(k => !CRITICAL_COMPONENTS.includes(k as typeof CRITICAL_COMPONENTS[number]))].map(comp => {
      const h = latestByComp.get(comp);
      if (!h) return { component: comp, status: "unknown", latency_ms: null, ageSec: null, stale: true };
      const ageSec = Math.round((now - new Date(h.observed_at).getTime()) / 1000);
      const stale = ageSec > STALE_MINUTES * 60;
      return { component: comp, status: stale ? "stale" : h.status, latency_ms: h.latency_ms, ageSec, stale };
    });

    // Snapshots + events
    const [snapR, eventR] = await Promise.all([
      supabase.from("state_snapshots").select("id,kind,captured_at").eq("user_id", userId).order("captured_at", { ascending: false }).limit(20),
      supabase.from("recovery_events").select("id,event_type,severity,message,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
    ]);

    const criticalDown = components.filter(c => CRITICAL_COMPONENTS.includes(c.component as typeof CRITICAL_COMPONENTS[number]) && (c.status === "stale" || c.status === "error")).length;
    const warnCount = components.filter(c => c.status === "warn").length;
    const healthScore = Math.max(0, 100 - criticalDown * 30 - warnCount * 10);

    return asJson({
      status,
      components,
      healthScore,
      snapshots: snapR.data ?? [],
      events: eventR.data ?? [],
    });
  });

// ---------- Watchdog: detect stale critical components and degrade ----------

export const runWatchdog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const status = await ensureStatus(supabase, userId);
    const now = Date.now();
    const cutoff = new Date(now - STALE_MINUTES * 60 * 1000).toISOString();

    const { data: recent } = await supabase
      .from("system_heartbeats")
      .select("component,status,observed_at")
      .eq("user_id", userId)
      .gte("observed_at", cutoff)
      .order("observed_at", { ascending: false })
      .limit(500);

    const seen = new Set<string>();
    const errs = new Set<string>();
    for (const r of recent ?? []) {
      seen.add(r.component);
      if (r.status === "error") errs.add(r.component);
    }
    const stale = CRITICAL_COMPONENTS.filter(c => !seen.has(c));
    const problems = [...stale.map(c => `${c}:stale`), ...Array.from(errs).map(c => `${c}:error`)];

    // If halted, watchdog does not override (user must clear manually).
    if (status.mode === "halted") {
      await supabase.from("system_status").update({ last_watchdog_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("user_id", userId);
      return asJson({ mode: "halted", problems, changed: false });
    }

    let nextMode = status.mode;
    let reason: string | null = status.reason ?? null;
    let changed = false;

    if (problems.length > 0 && status.mode !== "degraded") {
      nextMode = "degraded";
      reason = `Watchdog: ${problems.join(", ")}`;
      changed = true;
      await logEvent(supabase, userId, "watchdog_trip", "error", `Entering degraded mode (${problems.length} issue${problems.length === 1 ? "" : "s"})`, { problems });
    } else if (problems.length === 0 && status.mode === "degraded" && status.reason?.startsWith("Watchdog:")) {
      nextMode = "normal";
      reason = null;
      changed = true;
      await logEvent(supabase, userId, "degraded_exit", "info", "Watchdog cleared — returning to normal", {});
    }

    await supabase.from("system_status").update({
      mode: nextMode,
      reason,
      degraded_since: nextMode === "degraded" ? (status.degraded_since ?? new Date().toISOString()) : null,
      last_watchdog_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);

    return asJson({ mode: nextMode, problems, changed });
  });

// ---------- Manual mode control ----------

const ModeSchema = z.object({
  mode: z.enum(["normal", "degraded", "recovery", "halted"]),
  reason: z.string().max(280).optional(),
});

export const setSystemMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ModeSchema.parse(d))
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    const prev = await ensureStatus(supabase, userId);
    await supabase.from("system_status").update({
      mode: data.mode,
      reason: data.reason ?? null,
      degraded_since: data.mode === "degraded" ? (prev.degraded_since ?? new Date().toISOString()) : null,
      updated_at: new Date().toISOString(),
    }).eq("user_id", userId);
    await logEvent(supabase, userId,
      data.mode === "normal" ? "degraded_exit" : "degraded_enter",
      data.mode === "halted" ? "critical" : data.mode === "normal" ? "info" : "warn",
      `Mode changed: ${prev.mode} → ${data.mode}`,
      { reason: data.reason ?? null });
    return asJson({ ok: true, mode: data.mode });
  });

// ---------- State snapshot + recovery ----------

export const captureStateSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [posR, ordR, settingsR] = await Promise.all([
      supabase.from("positions").select("*").eq("user_id", userId).eq("status", "open").limit(500),
      supabase.from("orders").select("id,symbol,side,status,quantity,filled_quantity,avg_fill_price,created_at").eq("user_id", userId).in("status", ["pending", "submitted", "partial"]).limit(500),
      supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
    ]);
    const payload = {
      positions: posR.data ?? [],
      openOrders: ordR.data ?? [],
      settings: settingsR.data ?? null,
      capturedAt: new Date().toISOString(),
    };
    const [posSnap, ordSnap, cfgSnap] = await Promise.all([
      supabase.from("state_snapshots").insert({ user_id: userId, kind: "positions", payload: { positions: payload.positions } }).select("id").maybeSingle(),
      supabase.from("state_snapshots").insert({ user_id: userId, kind: "orders", payload: { orders: payload.openOrders } }).select("id").maybeSingle(),
      supabase.from("state_snapshots").insert({ user_id: userId, kind: "config", payload: { settings: payload.settings } }).select("id").maybeSingle(),
    ]);
    await logEvent(supabase, userId, "snapshot", "info", `Snapshot captured: ${payload.positions.length} positions, ${payload.openOrders.length} open orders`, {
      positionCount: payload.positions.length,
      orderCount: payload.openOrders.length,
    });

    // Prune old snapshots (keep last 20 per kind)
    for (const kind of ["positions", "orders", "config"]) {
      const { data: old } = await supabase
        .from("state_snapshots").select("id").eq("user_id", userId).eq("kind", kind)
        .order("captured_at", { ascending: false }).range(20, 200);
      const ids = (old ?? []).map(r => r.id);
      if (ids.length > 0) await supabase.from("state_snapshots").delete().in("id", ids);
    }

    return asJson({
      ok: true,
      snapshotIds: { positions: posSnap.data?.id, orders: ordSnap.data?.id, config: cfgSnap.data?.id },
      counts: { positions: payload.positions.length, openOrders: payload.openOrders.length },
    });
  });

export const runReconcile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // Snapshot the last known-good state
    const { data: latestPos } = await supabase
      .from("state_snapshots").select("payload,captured_at").eq("user_id", userId).eq("kind", "positions")
      .order("captured_at", { ascending: false }).limit(1).maybeSingle();

    const { data: currentPos } = await supabase
      .from("positions").select("id,symbol,status,quantity").eq("user_id", userId).eq("status", "open").limit(500);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshotPositions: any[] = (latestPos?.payload as { positions?: unknown[] } | null)?.positions as any[] ?? [];
    const currentIds = new Set((currentPos ?? []).map(p => p.id));
    const snapshotIds = new Set(snapshotPositions.map((p: { id: string }) => p.id));
    const missing = snapshotPositions.filter((p: { id: string }) => !currentIds.has(p.id)).length;
    const extra = (currentPos ?? []).filter(p => !snapshotIds.has(p.id)).length;

    const drift = missing + extra;
    await logEvent(supabase, userId, "reconcile", drift > 0 ? "warn" : "info",
      `Reconcile complete — ${drift} drift item${drift === 1 ? "" : "s"} (missing=${missing}, new=${extra})`,
      { missing, extra, snapshotAge: latestPos?.captured_at ?? null });

    return asJson({ ok: true, missing, extra, drift, snapshotCapturedAt: latestPos?.captured_at ?? null });
  });

// ---------- Auto-ping: run simple internal checks and record heartbeats ----------

export const runSelfCheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const results: { component: string; status: string; latency_ms: number }[] = [];

    // DB check
    const t0 = Date.now();
    const dbR = await supabase.from("system_status").select("mode").eq("user_id", userId).maybeSingle();
    results.push({ component: "database", status: dbR.error ? "error" : "ok", latency_ms: Date.now() - t0 });

    // Exchange connectivity check (based on connection health cache)
    const t1 = Date.now();
    const connR = await supabase.from("exchange_connections").select("health,last_reconcile_at").eq("user_id", userId).limit(10);
    const conns = connR.data ?? [];
    const anyUnhealthy = conns.some(c => c.health && c.health !== "ok" && c.health !== "healthy");
    results.push({
      component: "exchange",
      status: conns.length === 0 ? "warn" : anyUnhealthy ? "warn" : "ok",
      latency_ms: Date.now() - t1,
    });

    // Market data cache freshness
    const t2 = Date.now();
    const mdR = await supabase.from("candle_cache").select("cached_at").order("cached_at", { ascending: false }).limit(1).maybeSingle();
    const mdAge = mdR.data ? (Date.now() - new Date(mdR.data.cached_at).getTime()) / 1000 : Infinity;
    results.push({
      component: "market_data",
      status: mdAge < 3600 ? "ok" : mdAge < 86400 ? "warn" : "error",
      latency_ms: Date.now() - t2,
    });

    // AI engine liveness = recent signal activity
    const t3 = Date.now();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const sigR = await supabase.from("ai_signals").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", since);
    results.push({
      component: "ai_engine",
      status: (sigR.count ?? 0) > 0 ? "ok" : "warn",
      latency_ms: Date.now() - t3,
    });

    const inserts = results.map(r => ({ user_id: userId, component: r.component, status: r.status, latency_ms: r.latency_ms, detail: {} }));
    await supabase.from("system_heartbeats").insert(inserts);

    return asJson({ ok: true, results });
  });
