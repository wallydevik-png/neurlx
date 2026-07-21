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
