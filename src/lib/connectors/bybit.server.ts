// Production Bybit connector — v5 unified account API.
// Docs: https://bybit-exchange.github.io/docs/v5/intro
//
// Signing (v5): HMAC-SHA256 hex over
//    timestamp + apiKey + recvWindow + (queryString | rawBody)
// Header set: X-BAPI-API-KEY, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW, X-BAPI-SIGN.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { hmacSha256Hex } from "./signing.server";
import { doRequest } from "./rest.server";

const BASE = "https://api.bybit.com";
const RECV = "5000";

function toBybit(symbol: string): string {
  if (!symbol.includes("-")) return symbol.toUpperCase();
  const [b, q] = symbol.toUpperCase().split("-");
  return `${b}${q === "USD" ? "USDT" : q}`;
}

export function createBybitConnector(
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const apiKey = credentials.apiKey ?? "";
  const apiSecret = credentials.apiSecret ?? "";
  const hasKeys = Boolean(apiKey && apiSecret);
  const logCtx = { ...ctx, venue: "bybit" };

  async function sign(payload: string): Promise<{ ts: string; sig: string }> {
    const ts = Date.now().toString();
    const preSign = ts + apiKey + RECV + payload;
    return { ts, sig: await hmacSha256Hex(apiSecret, preSign) };
  }

  async function publicGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = `${BASE}${path}${params ? "?" + new URLSearchParams(params) : ""}`;
    return doRequest<T>({ ctx: logCtx, method: "GET", url, path, params });
  }

  async function signedGet<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    if (!hasKeys) throw new Error("Bybit API keys required for signed endpoints");
    const qs = new URLSearchParams(params).toString();
    const { ts, sig } = await sign(qs);
    return doRequest<T>({
      ctx: logCtx, method: "GET", path,
      url: `${BASE}${path}${qs ? "?" + qs : ""}`,
      headers: {
        "X-BAPI-API-KEY": apiKey, "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": RECV, "X-BAPI-SIGN": sig,
      },
      params, signed: true,
    });
  }

  async function signedPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!hasKeys) throw new Error("Bybit API keys required for signed endpoints");
    const raw = JSON.stringify(body);
    const { ts, sig } = await sign(raw);
    return doRequest<T>({
      ctx: logCtx, method: "POST", path, url: `${BASE}${path}`,
      headers: {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": apiKey, "X-BAPI-TIMESTAMP": ts,
        "X-BAPI-RECV-WINDOW": RECV, "X-BAPI-SIGN": sig,
      },
      body: raw, params: body, signed: true,
    });
  }

  return {
    id: "bybit", displayName: "Bybit", supportsRealExecution: hasKeys,

    async verify() {
      try {
        if (!hasKeys) {
          await publicGet<unknown>("/v5/market/time");
          return { ok: true, message: "Public data only (no API key)" };
        }
        const r = await signedGet<{ retCode: number; retMsg: string }>("/v5/account/wallet-balance", { accountType: "UNIFIED" });
        return { ok: r.retCode === 0, message: r.retMsg };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasKeys) return [];
      const r = await signedGet<{ result: { list: Array<{ coin: Array<{ coin: string; walletBalance: string; availableToWithdraw: string }> }> } }>(
        "/v5/account/wallet-balance", { accountType: "UNIFIED" },
      );
      const coins = r.result?.list?.[0]?.coin ?? [];
      return coins.map(c => ({
        currency: c.coin, total: Number(c.walletBalance || 0), available: Number(c.availableToWithdraw || c.walletBalance || 0),
      })).filter(b => b.total > 0);
    },

    async getQuote(symbol: string): Promise<Quote> {
      const s = toBybit(symbol);
      const r = await publicGet<{ result: { list: Array<{ symbol: string; bid1Price: string; ask1Price: string; lastPrice: string }> } }>(
        "/v5/market/tickers", { category: "spot", symbol: s },
      );
      const t = r.result?.list?.[0];
      if (!t) throw new Error(`No ticker for ${s}`);
      const bid = Number(t.bid1Price), ask = Number(t.ask1Price);
      return { symbol, bid, ask, mid: (bid + ask) / 2 || Number(t.lastPrice), ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      const body: Record<string, unknown> = {
        category: "spot", symbol: toBybit(input.symbol),
        side: input.side === "buy" ? "Buy" : "Sell",
        orderType: input.orderType === "market" ? "Market" : "Limit",
        qty: String(input.qty),
        ...(input.limitPrice ? { price: String(input.limitPrice) } : {}),
        ...(input.clientOrderId ? { orderLinkId: input.clientOrderId } : {}),
      };
      const r = await signedPost<{ retCode: number; retMsg: string; result: { orderId: string; orderLinkId: string } }>(
        "/v5/order/create", body,
      );
      if (r.retCode !== 0) throw new Error(`Bybit rejected: ${r.retMsg}`);
      return {
        externalOrderId: r.result.orderId, clientOrderId: r.result.orderLinkId,
        status: "working", fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
      };
    },

    async cancelOrder(externalOrderId: string, symbol?: string) {
      if (!symbol) return { ok: false };
      const r = await signedPost<{ retCode: number }>("/v5/order/cancel", {
        category: "spot", symbol: toBybit(symbol), orderId: externalOrderId,
      });
      return { ok: r.retCode === 0 };
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasKeys) return [];
      // Spot positions in Bybit v5 are represented as coin balances; perp positions are here.
      try {
        const r = await signedGet<{ result: { list: Array<{ symbol: string; size: string; avgPrice: string }> } }>(
          "/v5/position/list", { category: "linear", settleCoin: "USDT" },
        );
        return (r.result?.list ?? []).filter(p => Number(p.size) !== 0).map(p => ({
          symbol: p.symbol, qty: Number(p.size), avgEntry: Number(p.avgPrice),
        }));
      } catch { return []; }
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasKeys) return [];
      const r = await signedGet<{ result: { list: Array<{ orderId: string; symbol: string; side: string; execQty: string; execPrice: string; execFee: string; execTime: string }> } }>(
        "/v5/execution/list", { category: "spot", limit: String(limit) },
      );
      return (r.result?.list ?? []).map(x => ({
        externalOrderId: x.orderId, symbol: x.symbol,
        side: x.side.toLowerCase() === "buy" ? "buy" : "sell",
        qty: Number(x.execQty), price: Number(x.execPrice),
        fees: Number(x.execFee), ts: Number(x.execTime),
      }));
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        const r = await publicGet<{ time: number }>("/v5/market/time");
        const latency = Date.now() - t0;
        const skew = r.time ? r.time - Date.now() : null;
        return { ok: true, pingLatencyMs: latency, clockSkewMs: skew };
      } catch (e) {
        return { ok: false, pingLatencyMs: null, clockSkewMs: null, message: e instanceof Error ? e.message : String(e) };
      }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      if (!hasKeys) return { enableReading: false, enableSpotAndMarginTrading: false, enableWithdrawals: false };
      try {
        const r = await signedGet<{ result: { permissions: Record<string, string[]>; ips: string[] } }>("/v5/user/query-api");
        const perms = r.result?.permissions ?? {};
        const flat = new Set(Object.values(perms).flat());
        return {
          ipRestrict: (r.result?.ips ?? []).length > 0,
          enableReading: true,
          enableSpotAndMarginTrading: flat.has("SpotTrade") || flat.has("ContractTrade"),
          enableWithdrawals: flat.has("Withdraw"),
          raw: r.result,
        };
      } catch { return { enableReading: true, enableSpotAndMarginTrading: false, enableWithdrawals: false }; }
    },
  };
}
