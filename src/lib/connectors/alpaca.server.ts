// Production Alpaca connector — REST v2.
// Docs: https://alpaca.markets/docs/
// Auth: header-key (APCA-API-KEY-ID, APCA-API-SECRET-KEY). Environment picks base URL.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { doRequest } from "./rest.server";

function baseFor(env: string): string {
  return env === "live" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";
}
const DATA_BASE = "https://data.alpaca.markets";

export function createAlpacaConnector(
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const apiKey = credentials.apiKey ?? "";
  const apiSecret = credentials.apiSecret ?? "";
  const env = (credentials.environment ?? "paper").toLowerCase();
  const hasKeys = Boolean(apiKey && apiSecret);
  const base = baseFor(env);
  const logCtx = { ...ctx, venue: `alpaca:${env}` };
  const headers = () => ({
    "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": apiSecret,
    "Content-Type": "application/json",
  });

  async function req<T>(method: "GET" | "POST" | "DELETE", url: string, path: string, body?: unknown): Promise<T> {
    return doRequest<T>({
      ctx: logCtx, method, url, path, headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      params: body as Record<string, unknown> | undefined, signed: true,
    });
  }

  return {
    id: "alpaca", displayName: `Alpaca (${env})`, supportsRealExecution: hasKeys,

    async verify() {
      try {
        if (!hasKeys) return { ok: false, message: "API key + secret required" };
        const r = await req<{ status: string }>("GET", `${base}/v2/account`, "/v2/account");
        return { ok: r.status === "ACTIVE", message: `Account ${r.status}` };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasKeys) return [];
      const r = await req<{ cash: string; portfolio_value: string; currency: string }>("GET", `${base}/v2/account`, "/v2/account");
      return [{ currency: r.currency ?? "USD", total: Number(r.portfolio_value), available: Number(r.cash) }];
    },

    async getQuote(symbol: string): Promise<Quote> {
      const s = symbol.toUpperCase().replace("-", "");
      const r = await req<{ quote: { bp: number; ap: number; t: string } }>(
        "GET", `${DATA_BASE}/v2/stocks/${s}/quotes/latest`, `/v2/stocks/${s}/quotes/latest`,
      );
      const bid = r.quote?.bp ?? 0, ask = r.quote?.ap ?? 0;
      return { symbol, bid, ask, mid: (bid + ask) / 2, ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      const body: Record<string, unknown> = {
        symbol: input.symbol.replace("-", ""), qty: String(input.qty),
        side: input.side, type: input.orderType === "market" ? "market" : "limit",
        time_in_force: "day",
        ...(input.limitPrice ? { limit_price: String(input.limitPrice) } : {}),
        ...(input.clientOrderId ? { client_order_id: input.clientOrderId } : {}),
      };
      const r = await req<{ id: string; client_order_id: string; status: string }>(
        "POST", `${base}/v2/orders`, "/v2/orders", body,
      );
      return {
        externalOrderId: r.id, clientOrderId: r.client_order_id,
        status: r.status === "filled" ? "filled" : "working",
        fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
      };
    },

    async cancelOrder(externalOrderId: string) {
      try {
        await req<void>("DELETE", `${base}/v2/orders/${externalOrderId}`, `/v2/orders/${externalOrderId}`);
        return { ok: true };
      } catch { return { ok: false }; }
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasKeys) return [];
      const r = await req<Array<{ symbol: string; qty: string; avg_entry_price: string }>>(
        "GET", `${base}/v2/positions`, "/v2/positions",
      );
      return (r ?? []).map(p => ({ symbol: p.symbol, qty: Number(p.qty), avgEntry: Number(p.avg_entry_price) }));
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasKeys) return [];
      const r = await req<Array<{ id: string; symbol: string; side: string; filled_qty: string; filled_avg_price: string; filled_at: string }>>(
        "GET", `${base}/v2/orders?status=closed&limit=${limit}`, "/v2/orders",
      );
      return (r ?? []).filter(o => o.filled_qty).map(o => ({
        externalOrderId: o.id, symbol: o.symbol,
        side: o.side === "buy" ? "buy" : "sell",
        qty: Number(o.filled_qty), price: Number(o.filled_avg_price ?? 0),
        fees: 0, ts: o.filled_at ? new Date(o.filled_at).getTime() : Date.now(),
      }));
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        await req<{ timestamp: string }>("GET", `${base}/v2/clock`, "/v2/clock");
        return { ok: true, pingLatencyMs: Date.now() - t0, clockSkewMs: 0 };
      } catch (e) { return { ok: false, pingLatencyMs: null, clockSkewMs: null, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      if (!hasKeys) return { enableReading: false, enableSpotAndMarginTrading: false, enableWithdrawals: false };
      try {
        const r = await req<{ trading_blocked: boolean; transfers_blocked: boolean }>(
          "GET", `${base}/v2/account`, "/v2/account",
        );
        return {
          enableReading: true,
          enableSpotAndMarginTrading: !r.trading_blocked,
          enableWithdrawals: false, // Alpaca transfers are ACH bank flows, not brokered by the trading API.
          raw: r,
        };
      } catch { return { enableReading: true, enableSpotAndMarginTrading: false, enableWithdrawals: false }; }
    },
  };
}
