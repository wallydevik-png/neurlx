// Production MetaTrader connector — routed through the official MetaApi cloud
// bridge (https://metaapi.cloud/docs/). MetaApi is the MetaQuotes-approved
// gateway that lets server code talk to any broker's MT4/MT5 terminal.
//
// Every MT-only broker in the NeurlX registry (Octa, Exness, IC Markets,
// Pepperstone, FP Markets, XM, MT5, MT4) uses this exact connector. The
// broker is only cosmetic — the transport is one universal bridge.
//
// Credentials required from the user:
//   metaApiToken   — MetaApi provisioning token (bearer)
//   accountId      — MetaApi account ID for the linked MT5/MT4 login
//   region         — us-east-1 | london | new-york | singapore (optional)

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { doRequest } from "./rest.server";

function baseFor(region: string): string {
  const r = region || "new-york";
  return `https://mt-client-api-v1.${r}.agiliumtrade.ai`;
}
function toMt(symbol: string): string {
  // NeurlX "EUR-USD" → MT "EURUSD"; leave "XAUUSD" etc. alone.
  return symbol.toUpperCase().replace("-", "");
}

export function createMt5Connector(
  brokerId: string,
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const token = credentials.metaApiToken ?? credentials.accessToken ?? "";
  const accountId = credentials.accountId ?? credentials.mtAccountId ?? "";
  const region = credentials.region ?? "new-york";
  const hasCreds = Boolean(token && accountId);
  const base = baseFor(region);
  const logCtx = { ...ctx, venue: `mt5:${brokerId}` };
  const headers = () => ({ "auth-token": token, "Content-Type": "application/json" });

  async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return doRequest<T>({
      ctx: logCtx, method, path, url: `${base}${path}`,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      params: body as Record<string, unknown> | undefined, signed: true,
    });
  }

  const label = brokerId === "mt5" || brokerId === "mt4"
    ? "MetaTrader" : `${brokerId.toUpperCase()} · MetaTrader 5`;

  return {
    id: brokerId, displayName: label, supportsRealExecution: hasCreds,

    async verify() {
      try {
        if (!hasCreds) return { ok: false, message: "MetaApi token + account ID required" };
        const r = await req<{ balance: number; currency: string }>("GET", `/users/current/accounts/${accountId}/accountInformation`);
        return { ok: Number.isFinite(r.balance), message: `${r.currency} ${r.balance}` };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasCreds) return [];
      const r = await req<{ balance: number; equity: number; currency: string; freeMargin: number }>(
        "GET", `/users/current/accounts/${accountId}/accountInformation`,
      );
      return [{ currency: r.currency, total: r.equity, available: r.freeMargin }];
    },

    async getQuote(symbol: string): Promise<Quote> {
      const s = toMt(symbol);
      const r = await req<{ bid: number; ask: number }>("GET", `/users/current/accounts/${accountId}/symbols/${s}/current-price`);
      return { symbol, bid: r.bid, ask: r.ask, mid: (r.bid + r.ask) / 2, ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      const actionType = input.orderType === "market"
        ? (input.side === "buy" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL")
        : (input.side === "buy" ? "ORDER_TYPE_BUY_LIMIT" : "ORDER_TYPE_SELL_LIMIT");
      const body: Record<string, unknown> = {
        actionType,
        symbol: toMt(input.symbol),
        volume: input.qty,
        ...(input.limitPrice ? { openPrice: input.limitPrice } : {}),
        ...(input.clientOrderId ? { clientId: input.clientOrderId } : {}),
      };
      const r = await req<{ orderId: string; positionId?: string; numericCode: number; stringCode: string }>(
        "POST", `/users/current/accounts/${accountId}/trade`, { trade: body },
      );
      const success = r.stringCode === "TRADE_RETCODE_DONE" || r.numericCode === 10009;
      if (!success) throw new Error(`MT trade rejected: ${r.stringCode} (${r.numericCode})`);
      return {
        externalOrderId: r.positionId ?? r.orderId,
        clientOrderId: input.clientOrderId,
        status: input.orderType === "market" ? "filled" : "working",
        fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
      };
    },

    async cancelOrder(externalOrderId: string) {
      try {
        await req<void>("POST", `/users/current/accounts/${accountId}/trade`, {
          trade: { actionType: "ORDER_MODIFY", orderId: externalOrderId, close: true },
        });
        return { ok: true };
      } catch { return { ok: false }; }
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasCreds) return [];
      const r = await req<Array<{ symbol: string; volume: number; type: string; openPrice: number }>>(
        "GET", `/users/current/accounts/${accountId}/positions`,
      );
      return (r ?? []).map(p => ({
        symbol: p.symbol,
        qty: p.type === "POSITION_TYPE_SELL" ? -p.volume : p.volume,
        avgEntry: p.openPrice,
      }));
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasCreds) return [];
      const end = new Date().toISOString();
      const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      const r = await req<Array<{ id: string; symbol: string; type: string; volume: number; price: number; commission: number; time: string }>>(
        "GET", `/users/current/accounts/${accountId}/history-deals/time/${start}/${end}?limit=${limit}`,
      );
      return (r ?? []).map(d => ({
        externalOrderId: d.id, symbol: d.symbol,
        side: d.type === "DEAL_TYPE_SELL" ? "sell" : "buy",
        qty: d.volume, price: d.price,
        fees: Math.abs(d.commission ?? 0), ts: new Date(d.time).getTime(),
      }));
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        await req<unknown>("GET", `/users/current/accounts/${accountId}/accountInformation`);
        return { ok: true, pingLatencyMs: Date.now() - t0, clockSkewMs: 0 };
      } catch (e) { return { ok: false, pingLatencyMs: null, clockSkewMs: null, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      // MT permissions are set on the trading account, not on the API token —
      // investor password = read-only, trading password = read + trade.
      // Withdrawals are never performed via the trading protocol.
      return {
        enableReading: hasCreds, enableSpotAndMarginTrading: hasCreds, enableWithdrawals: false,
      };
    },
  };
}
