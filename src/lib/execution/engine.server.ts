// Execution Engine — connector-agnostic order lifecycle.
//
// Routing rules:
//   - `req.live === true` AND connection is trading-enabled AND circuit
//     breaker closed AND connector supports real execution → route to real
//     venue via factory + credentials.
//   - Everything else → paper connector (safe default).
//
// Live orders additionally pass through:
//   1. checkCircuitBreaker()
//   2. runPreTradeCheck() (venue-specific: health, permissions, filters, balance)
//   3. connector.placeOrder() with idempotent clientOrderId + retry
//   4. reconcileOrder() to sync fills, avg price, fees.
//
// The evaluateRisk() gate is enforced upstream by callers (approveSignalV2)
// and is never bypassed.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PlaceOrderInput, PlaceOrderResult, TradingConnector } from "@/lib/connectors/types";
import { createPaperConnector } from "@/lib/connectors/paper.server";

export type EngineOrderType = "market" | "limit" | "stop" | "trailing_stop";

export interface EngineOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  orderType: EngineOrderType;
  limitPrice?: number;
  stopPrice?: number;
  trailingStopPct?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  signalId?: string | null;
  connectionId?: string | null;
  live?: boolean;
}

export interface EngineExecutionResult {
  orderId: string;
  positionId: string | null;
  status: "filled" | "partially_filled" | "pending" | "rejected" | "error";
  filledPrice: number | null;
  filledQty: number;
  fees: number;
  slippageBps: number;
  isLive: boolean;
  message?: string;
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 250;

// ---------------------------------------------------------------------------
// Connector routing
// ---------------------------------------------------------------------------
async function routeConnector(
  supabase: SupabaseClient,
  userId: string,
  connectionId: string | null | undefined,
  wantLive: boolean,
  orderId: string,
): Promise<{ connector: TradingConnector; venue: string; isLive: boolean }> {
  let venue = "paper";
  if (!connectionId) {
    return { connector: createPaperConnector(), venue, isLive: false };
  }
  const { data: conn } = await supabase.from("exchange_connections")
    .select("id,connector_id,label,trading_enabled,status,credential_ciphertext")
    .eq("id", connectionId).eq("user_id", userId).maybeSingle();
  if (!conn) {
    return { connector: createPaperConnector(), venue, isLive: false };
  }
  venue = `${conn.connector_id}:${conn.label}`;

  if (!wantLive || !conn.trading_enabled || conn.status !== "connected"
      || conn.connector_id === "paper") {
    return { connector: createPaperConnector(), venue, isLive: false };
  }

  // Real execution path
  const { decryptJSON } = await import("@/lib/crypto.server");
  const { createConnector } = await import("@/lib/connectors/factory.server");
  const creds = conn.credential_ciphertext
    ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext)
    : {};
  const connector = createConnector(conn.connector_id, creds, {
    supabase, userId, connectionId: conn.id, orderId,
  });
  if (!connector.supportsRealExecution) {
    await logSafety(supabase, userId, "live_route_blocked",
      `Connector ${conn.connector_id} does not yet support real execution — falling back to paper.`);
    return { connector: createPaperConnector(), venue, isLive: false };
  }
  return { connector, venue, isLive: true };
}

async function logSafety(supabase: SupabaseClient, userId: string, event: string, message: string) {
  await supabase.from("execution_log").insert({
    user_id: userId, event, severity: "warn", message, payload: {},
  });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
export async function checkCircuitBreaker(
  supabase: SupabaseClient, userId: string,
): Promise<{ open: boolean; reason?: string }> {
  const { data: s } = await supabase.from("automation_settings")
    .select("live_kill_until, live_kill_reason, kill_switch_active")
    .eq("user_id", userId).maybeSingle();
  if (!s) return { open: false };
  if (s.kill_switch_active) return { open: true, reason: "Emergency kill switch is active." };
  if (s.live_kill_until && new Date(s.live_kill_until) > new Date()) {
    return { open: true, reason: s.live_kill_reason ?? "Live-execution circuit breaker is open." };
  }
  return { open: false };
}

async function tripCircuitBreaker(
  supabase: SupabaseClient, userId: string, reason: string,
) {
  const untilTomorrow = new Date();
  untilTomorrow.setUTCHours(23, 59, 59, 999);
  await supabase.from("automation_settings").update({
    live_kill_until: untilTomorrow.toISOString(),
    live_kill_reason: reason,
    live_consecutive_failures: 0,
  }).eq("user_id", userId);
  await supabase.from("execution_log").insert({
    user_id: userId, event: "circuit_breaker.trip", severity: "critical",
    message: reason, payload: { until: untilTomorrow.toISOString() },
  });
}

async function recordFailure(supabase: SupabaseClient, userId: string, kind: "failure" | "rejection") {
  const col = kind === "failure" ? "live_consecutive_failures" : "live_rejected_today";
  const { data } = await supabase.from("automation_settings").select(col).eq("user_id", userId).maybeSingle();
  const next = Number((data as Record<string, number> | null)?.[col] ?? 0) + 1;
  await supabase.from("automation_settings").update({ [col]: next }).eq("user_id", userId);
  if (kind === "failure" && next >= 3) {
    await tripCircuitBreaker(supabase, userId, "3 consecutive order failures — live trading auto-disabled for the day.");
  }
  if (kind === "rejection" && next >= 5) {
    await tripCircuitBreaker(supabase, userId, "5 rejected orders today — live trading auto-disabled for the day.");
  }
}

async function recordSuccess(supabase: SupabaseClient, userId: string) {
  await supabase.from("automation_settings")
    .update({ live_consecutive_failures: 0 })
    .eq("user_id", userId);
}

// ---------------------------------------------------------------------------
// Retryable connector wrapper — retries only transient/network errors
// ---------------------------------------------------------------------------
interface RetriableError extends Error { retryable?: boolean; duplicateOrder?: boolean }

async function placeOrderWithRetry(
  connector: TradingConnector, input: PlaceOrderInput,
  supabase: SupabaseClient, userId: string, orderId: string,
): Promise<PlaceOrderResult> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        await supabase.from("orders").update({ status: "retrying", retry_count: attempt })
          .eq("id", orderId);
        await supabase.from("execution_log").insert({
          user_id: userId, order_id: orderId, event: "order.retry",
          severity: "warn", message: `Retry ${attempt}/${MAX_RETRIES - 1}`, payload: { attempt },
        });
        await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
      }
      return await connector.placeOrder(input);
    } catch (e) {
      lastError = e;
      const re = e as RetriableError;
      if (!re.retryable) break; // don't retry business errors
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Order failed after retries");
}

// ---------------------------------------------------------------------------
// Main entry: submitOrder
// ---------------------------------------------------------------------------
export async function submitOrder(
  supabase: SupabaseClient, userId: string, req: EngineOrderRequest,
): Promise<EngineExecutionResult> {
  // 0. Circuit breaker guard
  const cb = await checkCircuitBreaker(supabase, userId);
  if (cb.open) {
    return { orderId: "", positionId: null, status: "rejected", filledPrice: null,
      filledQty: 0, fees: 0, slippageBps: 0, isLive: false, message: cb.reason };
  }

  // 1. Resolve account
  const { data: acct } = await supabase.from("paper_accounts")
    .select("*").eq("user_id", userId).maybeSingle();
  if (!acct) throw new Error("No paper account");

  // 2. Create pending order row so we have an ID for logs + clientOrderId
  const orderType = req.orderType;
  const { data: orderRow, error: orderErr } = await supabase.from("orders").insert({
    user_id: userId, account_id: acct.id,
    symbol: req.symbol, side: req.side, qty: req.qty,
    order_type: orderType,
    limit_price: req.limitPrice ?? null,
    stop_price: req.stopPrice ?? null,
    trailing_stop_pct: req.trailingStopPct ?? null,
    status: "pending",
    is_live: false,
    execution_venue: "paper",
    submitted_at: new Date().toISOString(),
  }).select().single();
  if (orderErr) throw orderErr;

  // 3. Choose connector (may still fall back to paper)
  const { connector, venue, isLive } = await routeConnector(
    supabase, userId, req.connectionId, req.live ?? false, orderRow.id,
  );

  // 4. Build idempotent client order id (Binance max 36 chars, [A-Za-z0-9_.-])
  const clientOrderId = `hlx_${orderRow.id.replace(/-/g, "").slice(0, 28)}`;
  await supabase.from("orders").update({
    is_live: isLive, execution_venue: venue, client_order_id: clientOrderId,
  }).eq("id", orderRow.id);

  await supabase.from("execution_log").insert({
    user_id: userId, order_id: orderRow.id, event: "order.submit",
    severity: "info",
    message: `Submitted ${req.side} ${req.qty} ${req.symbol} (${orderType}) ${isLive ? "LIVE" : "paper"} @ ${venue}`,
    payload: { req: { ...req, live: isLive }, venue, clientOrderId },
  });

  // 5. Live pre-trade check (skipped for paper — riskGate already ran)
  if (isLive) {
    const q = await connector.getQuote(req.symbol);
    const estPrice = req.side === "buy" ? q.ask : q.bid;
    const { runPreTradeCheck } = await import("@/lib/execution/preTradeCheck.server");
    const pre = await runPreTradeCheck(supabase, userId, connector, {
      symbol: req.symbol, side: req.side, qty: req.qty, estPrice,
      stopLoss: req.stopLoss ?? null, takeProfit: req.takeProfit ?? null,
      connectionId: req.connectionId!,
    });
    if (!pre.ok) {
      await supabase.from("orders").update({
        status: "rejected", error_message: pre.reason,
      }).eq("id", orderRow.id);
      await recordFailure(supabase, userId, "rejection");
      const { emitNotification } = await import("@/lib/notifications/emit.server");
      await emitNotification(supabase, userId, {
        kind: "trade.rejected", severity: "warning",
        title: `Live trade rejected: ${req.symbol}`,
        message: pre.reason ?? "Pre-trade check failed",
        payload: { orderId: orderRow.id, symbol: req.symbol, side: req.side, qty: req.qty },
      });
      return { orderId: orderRow.id, positionId: null, status: "rejected",
        filledPrice: null, filledQty: 0, fees: 0, slippageBps: 0, isLive: true,
        message: pre.reason };
    }
    if (pre.adjustments?.qty && pre.adjustments.qty !== req.qty) {
      req.qty = pre.adjustments.qty;
      await supabase.from("orders").update({ qty: req.qty }).eq("id", orderRow.id);
    }
  }

  // 6. Non-market orders: mark working; monitor loop handles fills for paper.
  //    On live venues, non-market orders are ACCEPTED by the exchange and
  //    tracked via reconcile — placeOrder() still submits them.
  if (orderType !== "market" && !isLive) {
    await supabase.from("orders").update({ status: "working" }).eq("id", orderRow.id);
    await supabase.from("execution_log").insert({
      user_id: userId, order_id: orderRow.id, event: "order.working",
      severity: "info", message: `${orderType} order accepted and monitoring`, payload: {},
    });
    return { orderId: orderRow.id, positionId: null, status: "pending",
      filledPrice: null, filledQty: 0, fees: 0, slippageBps: 0, isLive: false,
      message: `${orderType} order is working — will trigger on price condition.` };
  }

  // 7. Submit
  try {
    const placeInput: PlaceOrderInput = {
      symbol: req.symbol, side: req.side, qty: req.qty,
      orderType: mapOrderType(orderType),
      limitPrice: req.limitPrice, stopPrice: req.stopPrice,
      clientOrderId,
    };
    const result = await placeOrderWithRetry(connector, placeInput, supabase, userId, orderRow.id);

    // Paper path: simulate occasional partial fills for realism.
    let filledQty = result.filledQty ?? req.qty;
    let status: EngineExecutionResult["status"] = result.status === "partially_filled" ? "partially_filled"
      : result.status === "filled" ? "filled"
      : result.status === "working" ? "pending"
      : "filled";
    if (!isLive && Math.random() < 0.125) {
      filledQty = +(req.qty * (0.5 + Math.random() * 0.35)).toFixed(8);
      status = "partially_filled";
    }
    const notional = (result.filledPrice ?? 0) * filledQty;
    const fees = result.fees || +(notional * 0.001).toFixed(4);

    await supabase.from("orders").update({
      status, filled_price: result.filledPrice, fees, slippage_bps: result.slippageBps,
      filled_at: status === "filled" || status === "partially_filled"
        ? new Date().toISOString() : null,
      external_order_id: result.externalOrderId,
      qty: filledQty,
    }).eq("id", orderRow.id);

    await supabase.from("execution_log").insert({
      user_id: userId, order_id: orderRow.id, event: `order.${status}`,
      severity: "info",
      message: `${status === "filled" ? "Filled" : status === "partially_filled" ? "Partial fill" : "Working"} ${filledQty}@${result.filledPrice}`,
      payload: {
        filledPrice: result.filledPrice, fees, slippageBps: result.slippageBps,
        requestedQty: req.qty, filledQty, externalOrderId: result.externalOrderId,
        latencyMs: result.latencyMs,
      },
    });

    // 8. Reconciliation for live
    if (isLive && connector.getOrderStatus && result.externalOrderId) {
      const { reconcileOrder } = await import("@/lib/execution/reconcile.server");
      await reconcileOrder(supabase, userId, connector, orderRow.id);
    }

    await recordSuccess(supabase, userId);

    const { emitNotification } = await import("@/lib/notifications/emit.server");
    await emitNotification(supabase, userId, {
      kind: "trade.executed",
      severity: isLive ? "warning" : "info",
      title: `${isLive ? "LIVE" : "Paper"} ${req.side.toUpperCase()} ${req.symbol}`,
      message: `${status === "partially_filled" ? "Partial fill " : "Filled "}${filledQty} @ ${result.filledPrice ?? "?"} · fees ${fees}`,
      payload: { orderId: orderRow.id, symbol: req.symbol, side: req.side, qty: filledQty, price: result.filledPrice, live: isLive },
    });

    return {
      orderId: orderRow.id, positionId: null, status,
      filledPrice: result.filledPrice ?? null, filledQty, fees,
      slippageBps: result.slippageBps, isLive,
      message: status === "partially_filled" ? `Partial fill: ${filledQty} of ${req.qty}` : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown execution error";
    await supabase.from("orders").update({
      status: "error", error_message: msg,
    }).eq("id", orderRow.id);
    await supabase.from("execution_log").insert({
      user_id: userId, order_id: orderRow.id, event: "order.error",
      severity: "error", message: msg, payload: { isLive },
    });
    await recordFailure(supabase, userId, "failure");
    const { emitNotification } = await import("@/lib/notifications/emit.server");
    await emitNotification(supabase, userId, {
      kind: "trade.error", severity: isLive ? "critical" : "warning",
      title: `Execution error: ${req.symbol}`,
      message: msg, payload: { orderId: orderRow.id, live: isLive },
    });
    return { orderId: orderRow.id, positionId: null, status: "error",
      filledPrice: null, filledQty: 0, fees: 0, slippageBps: 0, isLive, message: msg };
  }
}

function mapOrderType(t: EngineOrderType): PlaceOrderInput["orderType"] {
  switch (t) {
    case "market": return "market";
    case "limit": return "limit";
    case "stop": return "stop_loss_limit";
    case "trailing_stop": return "market"; // trailing handled client-side
  }
}

// ---------------------------------------------------------------------------
// Working-order monitor — paper only (live venues track working orders via
// reconcile).
// ---------------------------------------------------------------------------
export async function evaluateWorkingOrders(
  supabase: SupabaseClient, userId: string,
): Promise<{ triggered: number }> {
  const { data: orders } = await supabase.from("orders")
    .select("*").eq("user_id", userId).eq("status", "working").eq("is_live", false).limit(50);
  if (!orders?.length) return { triggered: 0 };
  const paper = createPaperConnector();
  let triggered = 0;
  for (const o of orders) {
    const q = await paper.getQuote(o.symbol);
    const price = o.side === "buy" ? q.ask : q.bid;
    let shouldFill = false;
    if (o.order_type === "limit" && o.limit_price) {
      shouldFill = o.side === "buy" ? price <= Number(o.limit_price) : price >= Number(o.limit_price);
    } else if (o.order_type === "stop" && o.stop_price) {
      shouldFill = o.side === "buy" ? price >= Number(o.stop_price) : price <= Number(o.stop_price);
    } else if (o.order_type === "trailing_stop") {
      continue;
    }
    if (!shouldFill) continue;
    await submitOrder(supabase, userId, {
      symbol: o.symbol, side: o.side, qty: Number(o.qty),
      orderType: "market", connectionId: null, signalId: null,
    });
    await supabase.from("orders").update({
      status: "filled", filled_price: price, filled_at: new Date().toISOString(),
    }).eq("id", o.id);
    await supabase.from("execution_log").insert({
      user_id: userId, order_id: o.id, event: "order.triggered",
      severity: "info", message: `Working ${o.order_type} triggered at ${price}`, payload: { price },
    });
    triggered++;
  }
  return { triggered };
}
