// Assisted Live Trading server functions — permission scan, activation flow,
// position manager mutations, journal, execution log, performance metrics.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// ---------------------------------------------------------------------------
// PERMISSION SCAN
// ---------------------------------------------------------------------------
// Simulated: real Binance would call GET /api/v3/account and inspect the
// account permissions + apiRestrictions. In this build we produce a
// deterministic "safe" scan for paper connections and a "cautious" one for
// binance connections (assumes worst-case that keys have withdrawal enabled
// unless the user later re-scans with a permission-restricted key).
export const scanConnectionPermissions = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ connectionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: conn } = await context.supabase.from("exchange_connections")
      .select("*").eq("id", data.connectionId).eq("user_id", context.userId).maybeSingle();
    if (!conn) throw new Error("Connection not found");

    // Deterministic simulated scan
    let scan: {
      scopes: string[]; can_read: boolean; can_trade: boolean;
      can_withdraw: boolean; can_transfer_internal: boolean; can_margin: boolean;
      can_futures: boolean;
    };
    if (conn.connector_id === "paper") {
      scan = {
        scopes: ["read", "trade"], can_read: true, can_trade: true,
        can_withdraw: false, can_transfer_internal: false, can_margin: false, can_futures: false,
      };
    } else {
      // Real exchanges: assume worst case for the demo — user must recreate key
      // with withdrawals disabled before we allow live trading (simulated only).
      scan = {
        scopes: ["read", "trade", "withdraw", "transfer_internal"],
        can_read: true, can_trade: true, can_withdraw: true,
        can_transfer_internal: true, can_margin: false, can_futures: false,
      };
    }

    const unnecessary = [
      scan.can_transfer_internal ? "transfer_internal" : null,
      scan.can_margin ? "margin" : null,
      scan.can_futures ? "futures" : null,
    ].filter((x): x is string => x !== null);

    await context.supabase.from("exchange_connections").update({
      permission_scan: scan as unknown as Record<string, never>,
      withdrawal_detected: scan.can_withdraw,
      unnecessary_permissions: unnecessary,
      last_sync_at: new Date().toISOString(),
    }).eq("id", data.connectionId);

    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "connection.permission_scan",
      entity: "exchange_connections", entity_id: data.connectionId,
      payload: scan as unknown as Record<string, never>,
    });
    return scan;
  });

// ---------------------------------------------------------------------------
// LIVE TRADING ACTIVATION — requires typed phrase + safety checks
// ---------------------------------------------------------------------------
const ActivateSchema = z.object({
  connectionId: z.string().uuid(),
  confirmationPhrase: z.string(),
  maxNotionalPerOrder: z.number().positive().max(10000),
  acknowledgedWithdrawal: z.boolean().default(false),
});

export const activateLiveTrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ActivateSchema.parse(d))
  .handler(async ({ data, context }) => {
    if (data.confirmationPhrase !== "ENABLE LIVE TRADING") {
      throw new Error(`You must type "ENABLE LIVE TRADING" exactly to activate.`);
    }
    const { data: conn } = await context.supabase.from("exchange_connections")
      .select("*").eq("id", data.connectionId).eq("user_id", context.userId).maybeSingle();
    if (!conn) throw new Error("Connection not found");
    if (!conn.permission_scan) {
      throw new Error("Run a permission scan first — we won't enable trading on unaudited keys.");
    }
    if (conn.withdrawal_detected && !data.acknowledgedWithdrawal) {
      throw new Error("API key has WITHDRAWAL permission. Revoke it on the exchange and re-scan — or explicitly acknowledge the risk.");
    }
    // Live trading is now supported on connectors with real execution
    // (currently: Binance). Paper keeps its own simulation path.
    const isReal = conn.connector_id !== "paper";

    await context.supabase.from("exchange_connections").update({
      trading_enabled: true,
      trading_activated_at: new Date().toISOString(),
      max_notional_per_order: data.maxNotionalPerOrder,
    }).eq("id", data.connectionId);

    await context.supabase.from("automation_settings").update({
      live_max_notional_per_order: data.maxNotionalPerOrder,
      live_trading_enabled: isReal,
      activation_confirmed_phrase_at: new Date().toISOString(),
    }).eq("user_id", context.userId);

    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "live_trading.activate",
      entity: "exchange_connections", entity_id: data.connectionId,
      payload: {
        connector: conn.connector_id, maxNotional: data.maxNotionalPerOrder,
        isReal, acknowledgedWithdrawal: data.acknowledgedWithdrawal,
      },
    });

    return {
      ok: true, simulatedOnly: !isReal,
      message: isReal
        ? "Live trading activated. Every trade still requires your explicit approval."
        : "Paper trading activated.",
    };
  });

export const deactivateLiveTrading = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ connectionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase.from("exchange_connections").update({
      trading_enabled: false, trading_activated_at: null,
    }).eq("id", data.connectionId).eq("user_id", context.userId);
    await context.supabase.from("automation_settings").update({
      live_trading_enabled: false,
    }).eq("user_id", context.userId);
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "live_trading.deactivate",
      entity: "exchange_connections", entity_id: data.connectionId, payload: {},
    });
    return { ok: true };
  });

export const resetCircuitBreaker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("automation_settings").update({
      live_kill_until: null, live_kill_reason: null,
      live_consecutive_failures: 0, live_rejected_today: 0,
    }).eq("user_id", context.userId);
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "circuit_breaker.reset",
      entity: "automation_settings", entity_id: null, payload: {},
    });
    return { ok: true };
  });

// ---------------------------------------------------------------------------
// ASSISTED TRADE APPROVAL WITH MODIFY-SIZE
// ---------------------------------------------------------------------------
const ApproveSchema = z.object({
  signalId: z.string().uuid(),
  modifiedQty: z.number().positive().optional(),
  connectionId: z.string().uuid().optional(),
  live: z.boolean().optional(),
});

export const approveSignalV2 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => ApproveSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: sig } = await supabase.from("signals").select("*")
      .eq("id", data.signalId).eq("user_id", userId).maybeSingle();
    if (!sig) throw new Error("Signal not found");
    if (sig.status !== "pending") throw new Error(`Signal is ${sig.status}`);

    const qty = data.modifiedQty ?? Number(sig.qty);
    const entry = Number(sig.entry);
    const side = sig.side as "buy" | "sell";

    // Risk gate — authoritative, never bypassed
    const { evaluateRisk } = await import("@/lib/trading/riskGate.server");
    const decision = await evaluateRisk(supabase, userId, {
      symbol: sig.symbol, side, qty, entry,
      stopLoss: Number(sig.stop_loss), takeProfit: Number(sig.take_profit),
      confidence: Number(sig.confidence),
    });
    if (!decision.allowed) {
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", data.signalId);
      await supabase.from("audit_log").insert({
        user_id: userId, action: "trade.reject_by_risk",
        entity: "signals", entity_id: data.signalId,
        payload: { reason: decision.reason },
      });
      throw new Error(decision.reason ?? "Rejected by risk gate");
    }

    // Decide live vs paper. Live requires: explicit live flag from UI + a
    // trading-enabled connection on this user + circuit breaker closed +
    // per-order notional cap not exceeded.
    let live = Boolean(data.live);
    let connectionId: string | null = data.connectionId ?? null;
    if (live) {
      if (!connectionId) throw new Error("connectionId is required for live execution");
      const { data: conn } = await supabase.from("exchange_connections")
        .select("id,trading_enabled,status,connector_id")
        .eq("id", connectionId).eq("user_id", userId).maybeSingle();
      if (!conn || !conn.trading_enabled || conn.status !== "connected") {
        throw new Error("Selected connection is not enabled for live trading.");
      }
      const { data: settings } = await supabase.from("automation_settings").select("*")
        .eq("user_id", userId).maybeSingle();
      // Autonomous mode is handled separately (src/lib/autonomous.functions.ts).
      // Manual approvals remain available in any mode as an override.
      const notional = qty * entry;
      if (settings && notional > Number(settings.live_max_notional_per_order)) {
        throw new Error(`Order notional $${notional.toFixed(2)} exceeds live cap $${settings.live_max_notional_per_order}.`);
      }
    }

    // Submit through the execution engine
    const { submitOrder } = await import("@/lib/execution/engine.server");
    const result = await submitOrder(supabase, userId, {
      symbol: sig.symbol, side, qty,
      orderType: "market",
      stopLoss: Number(sig.stop_loss),
      takeProfit: Number(sig.take_profit),
      signalId: data.signalId,
      connectionId, live,
    });

    if (result.status === "rejected" || result.status === "error") {
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", data.signalId);
      throw new Error(result.message ?? "Execution failed");
    }

    // Create the position
    const { data: acct } = await supabase.from("paper_accounts").select("*")
      .eq("user_id", userId).maybeSingle();
    if (!acct) throw new Error("No paper account");

    const filledPrice = result.filledPrice ?? entry;
    const filledQty = result.filledQty;
    const { data: pos } = await supabase.from("positions").insert({
      user_id: userId, account_id: acct.id,
      symbol: sig.symbol, side: sig.side === "buy" ? "long" : "short",
      qty: filledQty, original_qty: qty, filled_qty: filledQty,
      avg_entry: filledPrice,
      stop_loss: sig.stop_loss, take_profit: sig.take_profit,
      trailing_stop_pct: 0.015,
      status: "open",
      ai_reasoning: sig.reasoning, ai_confidence: sig.confidence,
      ai_regime: sig.market_regime,
    }).select().single();

    await supabase.from("orders").update({ position_id: pos?.id })
      .eq("id", result.orderId);

    // Cash accounting only for paper (live venues manage their own).
    if (!result.isLive) {
      await supabase.from("paper_accounts").update({
        cash_balance: Number(acct.cash_balance) - filledPrice * filledQty - result.fees,
      }).eq("id", acct.id);
    }

    await supabase.from("signals").update({
      status: "executed", resolved_at: new Date().toISOString(),
    }).eq("id", data.signalId);

    await supabase.from("audit_log").insert({
      user_id: userId, action: "trade.approve", entity: "signals",
      entity_id: data.signalId,
      payload: {
        qty, filledPrice, filledQty, fees: result.fees,
        modified: data.modifiedQty !== undefined,
        partial: result.status === "partially_filled",
        isLive: result.isLive, connectionId,
      },
    });

    return {
      ok: true, positionId: pos?.id, filledPrice, filledQty,
      partial: result.status === "partially_filled",
      isLive: result.isLive,
      message: result.message,
    };
  });

// ---------------------------------------------------------------------------
// LIVE-ENABLED CONNECTIONS (used by the approvals UI to select execution venue)
// ---------------------------------------------------------------------------
export const listLiveConnections = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("exchange_connections")
      .select("id,label,connector_id,trading_enabled,status,health,max_notional_per_order,clock_skew_ms,last_reconcile_at")
      .eq("user_id", context.userId)
      .eq("trading_enabled", true)
      .eq("status", "connected");
    return data ?? [];
  });

// ---------------------------------------------------------------------------
// MANUAL RECONCILE (button on monitoring page)
// ---------------------------------------------------------------------------
export const reconcileNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ connectionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: conn } = await context.supabase.from("exchange_connections")
      .select("*").eq("id", data.connectionId).eq("user_id", context.userId).maybeSingle();
    if (!conn) throw new Error("Connection not found");
    const { decryptJSON } = await import("@/lib/crypto.server");
    const { createConnector } = await import("@/lib/connectors/factory.server");
    const { reconcileConnection } = await import("@/lib/execution/reconcile.server");
    const creds = conn.credential_ciphertext
      ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext)
      : {};
    const connector = createConnector(conn.connector_id, creds, {
      supabase: context.supabase, userId: context.userId, connectionId: conn.id,
    });
    return reconcileConnection(context.supabase, context.userId, connector, conn.id);
  });

// ---------------------------------------------------------------------------
// POSITION MANAGER MUTATIONS
// ---------------------------------------------------------------------------
export const movePositionStop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    positionId: z.string().uuid(), newStop: z.number().positive(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { moveStopLoss } = await import("@/lib/execution/positionManager.server");
    return moveStopLoss(context.supabase, context.userId, data.positionId, data.newStop);
  });

export const reducePositionSize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    positionId: z.string().uuid(), reduceQty: z.number().positive(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { reducePosition } = await import("@/lib/execution/positionManager.server");
    return reducePosition(context.supabase, context.userId, data.positionId, data.reduceQty);
  });

export const addToPositionSize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    positionId: z.string().uuid(), addQty: z.number().positive(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { addToPosition } = await import("@/lib/execution/positionManager.server");
    return addToPosition(context.supabase, context.userId, data.positionId, data.addQty);
  });

export const closePositionV2 = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    positionId: z.string().uuid(), reason: z.string().default("manual"),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { closePositionInternal } = await import("@/lib/execution/closePosition.server");
    return closePositionInternal(context.supabase, context.userId, data.positionId, data.reason);
  });

// Run profit protection on demand (also called by the dashboard poller)
export const tickProfitProtection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { runProfitProtection } = await import("@/lib/execution/positionManager.server");
    const { evaluateWorkingOrders } = await import("@/lib/execution/engine.server");
    const [pp, working] = await Promise.all([
      runProfitProtection(context.supabase, context.userId),
      evaluateWorkingOrders(context.supabase, context.userId),
    ]);
    return { profitProtectionActions: pp.actions, workingOrdersTriggered: working.triggered };
  });

// ---------------------------------------------------------------------------
// READS: journal, execution log, performance
// ---------------------------------------------------------------------------
export const listTradeJournal = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("trade_journal").select("*")
      .eq("user_id", context.userId).order("created_at", { ascending: false }).limit(100);
    return data ?? [];
  });

export const listExecutionLog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ positionId: z.string().uuid().optional() }).default({}).parse(d))
  .handler(async ({ data, context }) => {
    let q = context.supabase.from("execution_log").select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false }).limit(200);
    if (data.positionId) q = q.eq("position_id", data.positionId);
    const { data: rows } = await q;
    return rows ?? [];
  });

export const getPerformanceOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [acct, closedPos, journal, sigs, orders] = await Promise.all([
      supabase.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("positions").select("realized_pnl,closed_at,duration_seconds,ai_confidence")
        .eq("user_id", userId).eq("status", "closed"),
      supabase.from("trade_journal").select("execution_quality_score,slippage_bps_avg,fees_total,realized_pnl")
        .eq("user_id", userId),
      supabase.from("signals").select("status,created_at").eq("user_id", userId),
      supabase.from("orders").select("status,retry_count").eq("user_id", userId),
    ]);

    const closed = closedPos.data ?? [];
    const wins = closed.filter(p => Number(p.realized_pnl) > 0);
    const losses = closed.filter(p => Number(p.realized_pnl) < 0);
    const total = closed.length;
    const grossWin = wins.reduce((s, p) => s + Number(p.realized_pnl), 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + Number(p.realized_pnl), 0));

    // Monthly buckets
    const monthMap = new Map<string, number>();
    for (const p of closed) {
      if (!p.closed_at) continue;
      const d = new Date(p.closed_at);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      monthMap.set(key, (monthMap.get(key) ?? 0) + Number(p.realized_pnl));
    }
    const monthly = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, pnl]) => ({ month, pnl }));

    const j = journal.data ?? [];
    const avgQuality = j.length ? j.reduce((s, r) => s + Number(r.execution_quality_score ?? 0), 0) / j.length : 0;

    const sigRows = sigs.data ?? [];
    const decided = sigRows.filter(s => s.status === "executed" || s.status === "rejected");
    const approvedCount = sigRows.filter(s => s.status === "executed").length;
    const approvalRate = decided.length ? approvedCount / decided.length : 0;

    const orderRows = orders.data ?? [];
    const orderRetries = orderRows.reduce((s, o) => s + (o.retry_count ?? 0), 0);
    const orderErrors = orderRows.filter(o => o.status === "error").length;

    return {
      accountValue: Number(acct.data?.cash_balance ?? 0),
      totalRealized: closed.reduce((s, p) => s + Number(p.realized_pnl), 0),
      winRate: total ? wins.length / total : 0,
      totalClosed: total,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      monthly,
      avgQuality,
      approvalRate,
      totalSignals: sigRows.length,
      orderRetries,
      orderErrors,
      avgDurationSec: total ? closed.reduce((s, p) => s + (p.duration_seconds ?? 0), 0) / total : 0,
    };
  });
