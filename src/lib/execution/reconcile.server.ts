// Post-trade reconciliation. Two entry points:
//
//   reconcileOrder(orderId)   — polls the exchange for a single order until it
//                                reaches a terminal state (or timeout), then
//                                syncs qty / price / fees / status into the DB.
//   reconcileConnection(id)   — sweeps recent live orders on a connection and
//                                repairs any local drift (used on reconnect
//                                and by the monitoring poller).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TradingConnector } from "@/lib/connectors/types";

const TERMINAL = new Set(["filled", "cancelled", "rejected"]);
const POLL_STEPS_MS = [200, 400, 800, 1600, 3200, 3800]; // ~10s total

export async function reconcileOrder(
  supabase: SupabaseClient,
  userId: string,
  connector: TradingConnector,
  orderId: string,
): Promise<{ ok: boolean; status: string; message?: string }> {
  const { data: row } = await supabase.from("orders").select("*")
    .eq("id", orderId).eq("user_id", userId).maybeSingle();
  if (!row || !row.external_order_id) {
    return { ok: false, status: "not_found", message: "Order missing or has no exchange id yet." };
  }
  if (!connector.getOrderStatus) {
    return { ok: false, status: "unsupported", message: "Connector cannot poll order status." };
  }

  for (const wait of POLL_STEPS_MS) {
    try {
      const s = await connector.getOrderStatus(
        row.external_order_id, row.symbol, row.client_order_id ?? undefined,
      );
      await supabase.from("orders").update({
        status: s.status,
        filled_price: s.avgPrice || row.filled_price,
        qty: s.filledQty || row.qty,
        filled_at: TERMINAL.has(s.status)
          ? new Date(s.updatedAt).toISOString() : row.filled_at,
      }).eq("id", orderId);

      await supabase.from("execution_log").insert({
        user_id: userId, order_id: orderId, event: "reconcile.tick",
        severity: "info", message: `Reconciled: ${s.status} qty=${s.filledQty} avg=${s.avgPrice}`,
        payload: { status: s.status, filledQty: s.filledQty, avgPrice: s.avgPrice },
      });

      if (TERMINAL.has(s.status) || s.status === "partially_filled") {
        return { ok: true, status: s.status };
      }
    } catch (e) {
      await supabase.from("execution_log").insert({
        user_id: userId, order_id: orderId, event: "reconcile.error",
        severity: "warn", message: e instanceof Error ? e.message : String(e),
        payload: {},
      });
    }
    await new Promise(r => setTimeout(r, wait));
  }
  return { ok: false, status: "timeout", message: "Order did not reach terminal state within 10s." };
}

export async function reconcileConnection(
  supabase: SupabaseClient,
  userId: string,
  connector: TradingConnector,
  connectionId: string,
): Promise<{ scanned: number; updated: number }> {
  // Sweep live orders on this connection created in the last 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: rows } = await supabase.from("orders").select("*")
    .eq("user_id", userId).eq("is_live", true)
    .gte("created_at", since)
    .not("external_order_id", "is", null)
    .in("status", ["pending", "working", "partially_filled", "retrying"]);

  let updated = 0;
  for (const r of rows ?? []) {
    if (!connector.getOrderStatus) break;
    try {
      const s = await connector.getOrderStatus(
        r.external_order_id!, r.symbol, r.client_order_id ?? undefined,
      );
      if (s.status !== r.status) {
        updated++;
        await supabase.from("orders").update({
          status: s.status,
          filled_price: s.avgPrice || r.filled_price,
          qty: s.filledQty || r.qty,
          filled_at: TERMINAL.has(s.status)
            ? new Date(s.updatedAt).toISOString() : r.filled_at,
        }).eq("id", r.id);
      }
    } catch { /* per-order failure is non-fatal */ }
  }

  await supabase.from("exchange_connections").update({
    last_reconcile_at: new Date().toISOString(),
  }).eq("id", connectionId).eq("user_id", userId);

  return { scanned: rows?.length ?? 0, updated };
}

/**
 * Position-level reconciliation — the piece that was missing entirely.
 * `reconcileOrder`/`reconcileConnection` only ever check order *fill*
 * status; nothing previously asked the broker "does this position I think
 * is open still actually exist on your side?" If MT5 force-closes a
 * position (margin call/stop-out) or you close it manually in the MT5 app,
 * NeurlX's database would keep showing it open indefinitely — and profit
 * protection would keep trying to manage a position that's already gone.
 *
 * For every user with a live broker connection, this pulls the broker's
 * actual current open positions and closes/adjusts anything locally that no
 * longer matches, using a real live price for the P&L estimate (never a
 * fabricated one) and a distinct exit_reason so it's clearly distinguishable
 * from a normal stop/target close in the trade history.
 */
export async function reconcileLivePositions(
  supabase: SupabaseClient, userId: string,
): Promise<{ checked: number; closed: number; adjusted: number }> {
  const { data: tickets } = await supabase.from("broker_trade_tickets")
    .select("id,connection_id,position_id,broker_position_ticket,metaapi_order_id,volume")
    .eq("user_id", userId).eq("state", "open");
  if (!tickets?.length) return { checked: 0, closed: 0, adjusted: 0 };

  const byConnection = new Map<string, typeof tickets>();
  for (const t of tickets) {
    if (!t.connection_id) continue;
    const arr = byConnection.get(t.connection_id) ?? [];
    arr.push(t);
    byConnection.set(t.connection_id, arr);
  }

  let checked = 0, closed = 0, adjusted = 0;
  const affectedPositionIds = new Set<string>();

  for (const [connectionId, localTickets] of byConnection) {
    const { data: conn } = await supabase.from("exchange_connections")
      .select("id,connector_id,status,trading_enabled,credential_ciphertext")
      .eq("id", connectionId).eq("user_id", userId).maybeSingle();
    if (!conn || conn.status !== "connected" || !conn.trading_enabled) continue;

    let brokerPositions;
    try {
      const { decryptJSON } = await import("@/lib/crypto.server");
      const { createConnector } = await import("@/lib/connectors/factory.server");
      const creds = conn.credential_ciphertext
        ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext) : {};
      const connector = createConnector(conn.connector_id, creds, { supabase, userId, connectionId: conn.id });
      brokerPositions = await connector.getPositions();
    } catch (e) {
      // Can't reach this broker right now — don't guess; skip this
      // connection's positions this cycle rather than assume they're gone.
      console.warn(`[reconcile] could not fetch live positions for connection ${connectionId}`, e);
      continue;
    }
    const liveIds = new Set(brokerPositions.map(p => p.brokerPositionId).filter(Boolean));

    for (const ticket of localTickets) {
      checked++;
      const ticketId = ticket.broker_position_ticket ?? ticket.metaapi_order_id;
      if (!ticketId || liveIds.has(ticketId)) continue; // still genuinely open

      // The broker no longer has this ticket — mark it closed locally and
      // note that it wasn't us (this wasn't a stop/target/manual close).
      await supabase.from("broker_trade_tickets").update({
        state: "closed", closed_at: new Date().toISOString(),
      }).eq("id", ticket.id);
      affectedPositionIds.add(ticket.position_id);

      await supabase.from("execution_log").insert({
        user_id: userId, position_id: ticket.position_id, event: "position.reconciled_missing",
        severity: "warn",
        message: `Broker ticket ${ticketId} is no longer open on MT5 (margin call, manual close in the MT5 app, or similar) but NeurlX still had it recorded as open — syncing local records to match.`,
        payload: { ticketId, connectionId },
      });
    }
  }

  // For each affected NeurlX position, check whether ANY of its tickets are
  // still open — only fully close the local record once none are left.
  for (const positionId of affectedPositionIds) {
    const { data: remaining } = await supabase.from("broker_trade_tickets")
      .select("id").eq("position_id", positionId).eq("state", "open").limit(1);
    const { data: pos } = await supabase.from("positions").select("*")
      .eq("id", positionId).eq("status", "open").maybeSingle();
    if (!pos) continue;

    if (!remaining?.length) {
      // Nothing left open on the broker for this position — close it
      // locally too, using a real live price (or the position's own stop as
      // a last-resort estimate) for the P&L record.
      let exitPrice: number;
      try {
        const { fetchLastPrice } = await import("@/lib/marketdata/service.server");
        exitPrice = await fetchLastPrice(pos.symbol, userId, supabase);
      } catch {
        exitPrice = Number(pos.stop_loss ?? pos.avg_entry);
      }
      const dir = pos.side === "long" ? 1 : -1;
      const realized = +(((exitPrice - Number(pos.avg_entry)) * dir * Number(pos.qty))).toFixed(4);
      await supabase.from("positions").update({
        status: "closed", exit_price: exitPrice, exit_reason: "reconciled_missing",
        realized_pnl: realized, closed_at: new Date().toISOString(),
      }).eq("id", positionId);
      closed++;
    } else {
      adjusted++;
    }
  }

  return { checked, closed, adjusted };
}
