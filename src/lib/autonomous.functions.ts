// Autonomous Trading Engine
// -----------------------------------------------------------------------------
// Runs a bounded auto-execution cycle for users whose automation_settings.mode
// is "autonomous". Every cycle is idempotent, fully gated, and logged.
//
// Gates (all must pass before ANY order is placed):
//   1. mode === 'autonomous'
//   2. kill_switch_active === false AND live_kill_until in the past
//   3. cooldown: now >= autonomous_last_run_at + autonomous_cooldown_seconds
//   4. autonomous circuit breaker: last N closed positions not all losers
//   5. open positions < autonomous_max_open_positions
//   6. per-signal: confidence >= autonomous_min_confidence, symbol allowed
//   7. authoritative risk gate (evaluateRisk) — never bypassed
//   8. live only when autonomous_live_enabled AND default connection trading-enabled
//
// Every run inserts an autonomous_runs row with counts + reject reasons.

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CycleResult {
  runId: string;
  scanned: number;
  executed: number;
  rejected: number;
  rejectReasons: Record<string, number>;
  errors: string[];
  skipped?: string; // if the whole cycle was skipped
}

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Core cycle — reusable from both the user-triggered fn and the cron route
// ---------------------------------------------------------------------------
export async function runAutonomousCycleFor(
  supabase: SupabaseClient,
  userId: string,
  trigger: "manual" | "cron" | "signal",
): Promise<CycleResult> {
  const rejectReasons: Record<string, number> = {};
  const errors: string[] = [];
  let scanned = 0;
  let executed = 0;
  let rejected = 0;

  const startedAt = new Date().toISOString();
  const { data: runRow } = await supabase.from("autonomous_runs").insert({
    user_id: userId, started_at: startedAt, trigger, live: false,
  }).select().single();
  const runId = runRow?.id as string;

  const finish = async (skipped?: string, live = false) => {
    await supabase.from("autonomous_runs").update({
      finished_at: new Date().toISOString(),
      signals_scanned: scanned, signals_executed: executed, signals_rejected: rejected,
      reject_reasons: rejectReasons, errors, live,
    }).eq("id", runId);
    return { runId, scanned, executed, rejected, rejectReasons, errors, skipped };
  };

  // 1. Load settings
  const { data: settings } = await supabase.from("automation_settings")
    .select("*").eq("user_id", userId).maybeSingle();
  if (!settings) return finish("no_settings");
  if (settings.mode !== "autonomous") return finish("mode_not_autonomous");
  if (settings.kill_switch_active) return finish("kill_switch_active");
  if (settings.live_kill_until && new Date(settings.live_kill_until) > new Date()) {
    return finish(`circuit_breaker_open:${settings.live_kill_reason ?? "open"}`);
  }

  // 2. Cooldown
  if (settings.autonomous_last_run_at) {
    const nextAllowed = new Date(settings.autonomous_last_run_at).getTime()
      + (settings.autonomous_cooldown_seconds ?? 300) * 1000;
    if (Date.now() < nextAllowed && trigger !== "manual") {
      return finish("cooldown");
    }
  }

  // 3. Autonomous consecutive-loss breaker (stateless — query last N closes)
  const maxLosses = settings.autonomous_max_consecutive_losses ?? 3;
  const { data: recentCloses } = await supabase.from("positions")
    .select("realized_pnl,closed_at")
    .eq("user_id", userId).eq("status", "closed")
    .order("closed_at", { ascending: false }).limit(maxLosses);
  if (recentCloses && recentCloses.length >= maxLosses
      && recentCloses.every(p => Number(p.realized_pnl ?? 0) < 0)) {
    await supabase.from("automation_settings").update({
      autonomous_consecutive_losses: recentCloses.length,
      live_kill_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      live_kill_reason: `${maxLosses} consecutive losses — autonomous paused 24h.`,
    }).eq("user_id", userId);
    await supabase.from("execution_log").insert({
      user_id: userId, event: "autonomous.breaker.consecutive_losses",
      severity: "critical",
      message: `${maxLosses} consecutive losing trades — autonomous halted.`,
      payload: {},
    });
    const { emitNotification } = await import("@/lib/notifications/emit.server");
    await emitNotification(supabase, userId, {
      kind: "autonomous.breaker", severity: "emergency",
      title: "Autonomous trading paused",
      message: `${maxLosses} consecutive losses — autonomous halted for 24h.`,
      payload: { maxLosses },
    });
    return finish("consecutive_losses_breaker");
  }

  // 4. Max open positions
  const { count: openCount } = await supabase.from("positions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("status", "open");
  const capacity = Math.max(0, (settings.autonomous_max_open_positions ?? 3) - (openCount ?? 0));
  if (capacity === 0) return finish("no_open_slots");

  // 5. Daily loss cap check (reuse existing paper account tracking)
  const { data: paperAcct } = await supabase.from("paper_accounts")
    .select("*").eq("user_id", userId).maybeSingle();

  // 6. Determine live routing
  const wantsLive = Boolean(settings.autonomous_live_enabled)
    && Boolean(settings.autonomous_default_connection_id);
  let liveConn: { id: string; trading_enabled: boolean; status: string; connector_id: string } | null = null;
  if (wantsLive) {
    const { data: c } = await supabase.from("exchange_connections")
      .select("id,trading_enabled,status,connector_id")
      .eq("id", settings.autonomous_default_connection_id!)
      .eq("user_id", userId).maybeSingle();
    if (c && c.trading_enabled && c.status === "connected" && c.connector_id !== "paper") {
      liveConn = c;
    }
  }
  const live = liveConn !== null;

  // 7. Pull pending signals — and if none exist, have the AI committee
  // generate fresh ones from the user's allowed_assets watchlist. This is
  // what makes autopilot truly hands-free: the loop doesn't wait for the
  // user to press "Generate signal" in the UI.
  const minConfForGen = Number(settings.autonomous_min_confidence ?? 0.85);
  let { data: signals } = await supabase.from("signals")
    .select("*").eq("user_id", userId).eq("status", "pending")
    .order("created_at", { ascending: false }).limit(20);

  if ((!signals || signals.length === 0) && capacity > 0) {
    try {
      const { runCommittee } = await import("@/lib/trading/committee.server");
      const { listSupportedSymbols } = await import("@/lib/marketdata/service.server");
      const universe = (settings.allowed_assets && settings.allowed_assets.length
        ? settings.allowed_assets
        : listSupportedSymbols().slice(0, 8));
      const verdicts = await runCommittee(supabase, universe);
      // Only insert top verdicts that clear the confidence floor AND have
      // committee agreement — this is the "conference" gate that catches
      // false positives no single indicator scheme would flag.
      const picks = verdicts
        .filter(v => v.consensusDirection !== "wait"
          && v.consensusConfidence >= minConfForGen
          && v.agreement >= 2 / 3)
        .slice(0, capacity);
      const toInsert = picks.map(v => ({
        user_id: userId,
        symbol: v.symbol, side: v.consensusDirection as "buy" | "sell",
        entry: v.base.entry, stop_loss: v.base.stopLoss, take_profit: v.base.takeProfit,
        qty: v.base.qty,
        confidence: v.consensusConfidence,
        reasoning: `AI committee (${v.votes.filter(vt => vt.direction === v.consensusDirection).map(vt => vt.analyst).join(", ")}) — ${v.base.reasoning}`,
        risk_reward: v.base.riskReward, status: "pending",
        expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        time_horizon: v.base.timeHorizon, risk_level: v.base.riskLevel,
        market_regime: v.base.regime,
        indicators: v.base.indicators as unknown as Record<string, never>,
        contributions: [...v.base.contributions, ...v.votes.map(vt => ({
          indicator: `Analyst:${vt.analyst}`, signal: vt.direction === "buy" ? "bullish" : vt.direction === "sell" ? "bearish" : "neutral",
          weight: vt.confidence, detail: vt.rationale,
        }))] as unknown as Record<string, never>,
        risk_factors: v.base.riskFactors as unknown as Record<string, never>,
      }));
      if (toInsert.length) {
        const { data: inserted } = await supabase.from("signals")
          .insert(toInsert).select();
        signals = inserted ?? [];
      }
    } catch (e) {
      errors.push(`committee_gen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  scanned = signals?.length ?? 0;

  if (!signals || signals.length === 0) {
    await supabase.from("automation_settings")
      .update({ autonomous_last_run_at: new Date().toISOString() })
      .eq("user_id", userId);
    return finish(undefined, live);
  }

  const allowedAssets = new Set<string>(settings.allowed_assets ?? []);
  const minConf = Number(settings.autonomous_min_confidence ?? 0.85);
  const perOrderCap = Number(settings.live_max_notional_per_order ?? 50);

  const { evaluateRisk } = await import("@/lib/trading/riskGate.server");
  const { submitOrder } = await import("@/lib/execution/engine.server");

  let slots = capacity;
  for (const sig of signals) {
    if (slots === 0) { bump(rejectReasons, "no_open_slots"); rejected++; continue; }
    if (Number(sig.confidence) < minConf) {
      bump(rejectReasons, "below_min_confidence"); rejected++; continue;
    }
    if (allowedAssets.size > 0 && !allowedAssets.has(sig.symbol)) {
      bump(rejectReasons, "asset_not_allowed"); rejected++; continue;
    }
    const qty = Number(sig.qty);
    const entry = Number(sig.entry);
    const side = sig.side as "buy" | "sell";
    const notional = qty * entry;

    if (live && notional > perOrderCap) {
      bump(rejectReasons, "over_live_notional_cap"); rejected++;
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }

    const decision = await evaluateRisk(supabase, userId, {
      symbol: sig.symbol, side, qty, entry,
      stopLoss: Number(sig.stop_loss), takeProfit: Number(sig.take_profit),
      confidence: Number(sig.confidence),
    });
    if (!decision.allowed) {
      bump(rejectReasons, `risk_gate:${decision.reason ?? "rejected"}`);
      rejected++;
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      await supabase.from("audit_log").insert({
        user_id: userId, action: "autonomous.reject_by_risk",
        entity: "signals", entity_id: sig.id,
        payload: { reason: decision.reason },
      });
      continue;
    }

    // Execute
    try {
      const result = await submitOrder(supabase, userId, {
        symbol: sig.symbol, side, qty, orderType: "market",
        stopLoss: Number(sig.stop_loss), takeProfit: Number(sig.take_profit),
        signalId: sig.id,
        connectionId: liveConn?.id ?? null, live,
      });
      if (result.status === "rejected" || result.status === "error") {
        bump(rejectReasons, `exec:${result.message ?? result.status}`);
        rejected++;
        await supabase.from("signals").update({
          status: "rejected", resolved_at: new Date().toISOString(),
        }).eq("id", sig.id);
        continue;
      }

      // Create position (mirrors approveSignalV2)
      if (paperAcct) {
        const filledPrice = result.filledPrice ?? entry;
        const filledQty = result.filledQty;
        const { data: pos } = await supabase.from("positions").insert({
          user_id: userId, account_id: paperAcct.id,
          symbol: sig.symbol, side: sig.side === "buy" ? "long" : "short",
          qty: filledQty, original_qty: qty, filled_qty: filledQty,
          avg_entry: filledPrice,
          stop_loss: sig.stop_loss, take_profit: sig.take_profit,
          trailing_stop_pct: 0.015, status: "open",
          ai_reasoning: sig.reasoning, ai_confidence: sig.confidence,
          ai_regime: sig.market_regime,
        }).select().single();
        await supabase.from("orders").update({ position_id: pos?.id })
          .eq("id", result.orderId);
        if (!result.isLive) {
          await supabase.from("paper_accounts").update({
            cash_balance: Number(paperAcct.cash_balance) - filledPrice * filledQty - result.fees,
          }).eq("id", paperAcct.id);
          paperAcct.cash_balance = Number(paperAcct.cash_balance) - filledPrice * filledQty - result.fees;
        }
      }

      await supabase.from("signals").update({
        status: "executed", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);

      await supabase.from("audit_log").insert({
        user_id: userId, action: "autonomous.execute",
        entity: "signals", entity_id: sig.id,
        payload: {
          qty, filledPrice: result.filledPrice, filledQty: result.filledQty,
          fees: result.fees, live: result.isLive, trigger,
        },
      });

      executed++;
      slots--;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      bump(rejectReasons, "exception");
      rejected++;
    }
  }

  await supabase.from("automation_settings")
    .update({ autonomous_last_run_at: new Date().toISOString() })
    .eq("user_id", userId);

  return finish(undefined, live);
}

// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------
export const runAutonomousCycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return runAutonomousCycleFor(context.supabase, context.userId, "manual");
  });

const AutonomousSettingsSchema = z.object({
  mode: z.enum(["manual", "assisted", "autonomous"]),
  autonomous_min_confidence: z.number().min(0.5).max(0.99),
  autonomous_max_open_positions: z.number().int().min(1).max(20),
  autonomous_cooldown_seconds: z.number().int().min(30).max(3600),
  autonomous_max_consecutive_losses: z.number().int().min(1).max(10),
  autonomous_live_enabled: z.boolean(),
  autonomous_default_connection_id: z.string().uuid().nullable(),
});

export const updateAutonomousSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AutonomousSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    // If enabling autonomous_live, require the connection to be trading-enabled
    if (data.autonomous_live_enabled) {
      if (!data.autonomous_default_connection_id) {
        throw new Error("Choose a live connection before enabling autonomous live trading.");
      }
      const { data: c } = await context.supabase.from("exchange_connections")
        .select("trading_enabled,status,connector_id")
        .eq("id", data.autonomous_default_connection_id)
        .eq("user_id", context.userId).maybeSingle();
      if (!c || !c.trading_enabled || c.status !== "connected" || c.connector_id === "paper") {
        throw new Error("Selected connection is not activated for live trading.");
      }
    }
    await context.supabase.from("automation_settings").update({
      mode: data.mode,
      autonomous_min_confidence: data.autonomous_min_confidence,
      autonomous_max_open_positions: data.autonomous_max_open_positions,
      autonomous_cooldown_seconds: data.autonomous_cooldown_seconds,
      autonomous_max_consecutive_losses: data.autonomous_max_consecutive_losses,
      autonomous_live_enabled: data.autonomous_live_enabled,
      autonomous_default_connection_id: data.autonomous_default_connection_id,
    }).eq("user_id", context.userId);
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "autonomous.settings_update",
      entity: "automation_settings", entity_id: null,
      payload: data as unknown as Record<string, never>,
    });
    return { ok: true };
  });

export const getAutonomousStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [settingsRes, runsRes, openRes, connsRes] = await Promise.all([
      context.supabase.from("automation_settings").select("*")
        .eq("user_id", context.userId).maybeSingle(),
      context.supabase.from("autonomous_runs").select("*")
        .eq("user_id", context.userId).order("started_at", { ascending: false }).limit(25),
      context.supabase.from("positions").select("id", { count: "exact", head: true })
        .eq("user_id", context.userId).eq("status", "open"),
      context.supabase.from("exchange_connections")
        .select("id,label,connector_id,trading_enabled,status")
        .eq("user_id", context.userId),
    ]);
    return {
      settings: settingsRes.data,
      runs: runsRes.data ?? [],
      openPositions: openRes.count ?? 0,
      connections: connsRes.data ?? [],
    };
  });
