// Production OANDA connector — v20 REST.
// Docs: https://developer.oanda.com/rest-live-v20/introduction/
// Auth: Personal Access Token in Authorization: Bearer <token>.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { doRequest } from "./rest.server";

function baseFor(env: string): string {
  return env === "live" ? "https://api-fxtrade.oanda.com" : "https://api-fxpractice.oanda.com";
}
function toOanda(symbol: string): string {
  // NeurlX "EUR-USD" → OANDA "EUR_USD".
  return symbol.toUpperCase().replace("-", "_");
}

export function createOandaConnector(
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const token = credentials.accessToken ?? "";
  const accountId = credentials.accountId ?? "";
  const env = (credentials.environment ?? "practice").toLowerCase();
  const hasCreds = Boolean(token && accountId);
  const base = baseFor(env);
  const logCtx = { ...ctx, venue: `oanda:${env}` };
  const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

  async function req<T>(method: "GET" | "POST" | "PUT", url: string, path: string, body?: unknown): Promise<T> {
    return doRequest<T>({
      ctx: logCtx, method, url, path, headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      params: body as Record<string, unknown> | undefined, signed: true,
    });
  }

  return {
    id: "oanda", displayName: `OANDA (${env})`, supportsRealExecution: hasCreds,

    async verify() {
      try {
        if (!hasCreds) return { ok: false, message: "Access token + account ID required" };
        const r = await req<{ account: { id: string; currency: string } }>(
          "GET", `${base}/v3/accounts/${accountId}`, `/v3/accounts/${accountId}`,
        );
        return { ok: Boolean(r.account?.id), message: `Currency ${r.account?.currency ?? "?"}` };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasCreds) return [];
      const r = await req<{ account: { balance: string; currency: string; marginAvailable: string } }>(
        "GET", `${base}/v3/accounts/${accountId}/summary`, `/v3/accounts/${accountId}/summary`,
      );
      return [{
        currency: r.account.currency, total: Number(r.account.balance),
        available: Number(r.account.marginAvailable ?? r.account.balance),
      }];
    },

    async getQuote(symbol: string): Promise<Quote> {
      const inst = toOanda(symbol);
      const r = await req<{ prices: Array<{ instrument: string; bids: Array<{ price: string }>; asks: Array<{ price: string }> }> }>(
        "GET", `${base}/v3/accounts/${accountId}/pricing?instruments=${inst}`, `/v3/accounts/${accountId}/pricing`,
      );
      const p = r.prices?.[0];
      if (!p) throw new Error(`No price for ${inst}`);
      const bid = Number(p.bids[0].price), ask = Number(p.asks[0].price);
      return { symbol, bid, ask, mid: (bid + ask) / 2, ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      const units = String((input.side === "sell" ? -1 : 1) * input.qty);
      const order: Record<string, unknown> = {
        instrument: toOanda(input.symbol), units,
        type: input.orderType === "market" ? "MARKET" : "LIMIT",
        timeInForce: input.orderType === "market" ? "FOK" : "GTC",
        ...(input.limitPrice ? { price: String(input.limitPrice) } : {}),
        ...(input.clientOrderId ? { clientExtensions: { id: input.clientOrderId } } : {}),
      };
      const r = await req<{ orderFillTransaction?: { id: string; price: string; units: string }; orderCreateTransaction?: { id: string } }>(
        "POST", `${base}/v3/accounts/${accountId}/orders`, `/v3/accounts/${accountId}/orders`,
        { order },
      );
      const fill = r.orderFillTransaction;
      const create = r.orderCreateTransaction;
      return {
        externalOrderId: fill?.id ?? create?.id ?? "",
        clientOrderId: input.clientOrderId,
        status: fill ? "filled" : "working",
        filledPrice: fill ? Number(fill.price) : undefined,
        filledQty: fill ? Math.abs(Number(fill.units)) : undefined,
        fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
      };
    },

    async cancelOrder(externalOrderId: string) {
      try {
        await req<void>("PUT", `${base}/v3/accounts/${accountId}/orders/${externalOrderId}/cancel`, `/v3/accounts/${accountId}/orders/cancel`);
        return { ok: true };
      } catch { return { ok: false }; }
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasCreds) return [];
      const r = await req<{ positions: Array<{ instrument: string; long: { units: string; averagePrice?: string }; short: { units: string; averagePrice?: string } }> }>(
        "GET", `${base}/v3/accounts/${accountId}/openPositions`, `/v3/accounts/${accountId}/openPositions`,
      );
      const out: ConnectorPosition[] = [];
      for (const p of r.positions ?? []) {
        const lq = Number(p.long.units), sq = Number(p.short.units);
        if (lq) out.push({ symbol: p.instrument, qty: lq, avgEntry: Number(p.long.averagePrice ?? 0) });
        if (sq) out.push({ symbol: p.instrument, qty: sq, avgEntry: Number(p.short.averagePrice ?? 0) });
      }
      return out;
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasCreds) return [];
      const r = await req<{ transactions: Array<{ id: string; instrument?: string; units?: string; price?: string; time: string; type: string }> }>(
        "GET", `${base}/v3/accounts/${accountId}/transactions?pageSize=${limit}&type=ORDER_FILL`,
        `/v3/accounts/${accountId}/transactions`,
      );
      return (r.transactions ?? []).filter(t => t.instrument && t.units && t.price).map(t => ({
        externalOrderId: t.id, symbol: t.instrument!,
        side: Number(t.units) >= 0 ? "buy" : "sell",
        qty: Math.abs(Number(t.units)), price: Number(t.price),
        fees: 0, ts: new Date(t.time).getTime(),
      }));
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        await req<{ accounts: unknown[] }>("GET", `${base}/v3/accounts`, "/v3/accounts");
        return { ok: true, pingLatencyMs: Date.now() - t0, clockSkewMs: 0 };
      } catch (e) { return { ok: false, pingLatencyMs: null, clockSkewMs: null, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      // OANDA tokens are all-or-nothing per account; presence implies trading rights.
      return {
        enableReading: hasCreds, enableSpotAndMarginTrading: hasCreds, enableWithdrawals: false,
      };
    },
  };
}
