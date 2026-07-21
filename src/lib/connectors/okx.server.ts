// Production OKX connector — v5 unified account API.
// Docs: https://www.okx.com/docs-v5/en/
//
// Signing: base64(HMAC-SHA256(secret, timestamp + method + requestPath + body))
// Headers: OK-ACCESS-KEY, OK-ACCESS-SIGN, OK-ACCESS-TIMESTAMP, OK-ACCESS-PASSPHRASE.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { hmacSha256Base64 } from "./signing.server";
import { doRequest } from "./rest.server";

const BASE = "https://www.okx.com";

function toOkx(symbol: string): string {
  if (symbol.includes("-")) return symbol.toUpperCase();
  return symbol.toUpperCase().replace(/USDT$/, "-USDT").replace(/USD$/, "-USD");
}

export function createOkxConnector(
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const apiKey = credentials.apiKey ?? "";
  const apiSecret = credentials.apiSecret ?? "";
  const passphrase = credentials.passphrase ?? "";
  const hasKeys = Boolean(apiKey && apiSecret && passphrase);
  const logCtx = { ...ctx, venue: "okx" };

  async function signed<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    if (!hasKeys) throw new Error("OKX requires apiKey + apiSecret + passphrase");
    const ts = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : "";
    const sign = await hmacSha256Base64(apiSecret, ts + method + path + bodyStr);
    return doRequest<T>({
      ctx: logCtx, method, path, url: `${BASE}${path}`,
      headers: {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": passphrase,
      },
      body: bodyStr || undefined, params: body, signed: true,
    });
  }

  async function publicGet<T>(path: string): Promise<T> {
    return doRequest<T>({ ctx: logCtx, method: "GET", url: `${BASE}${path}`, path });
  }

  return {
    id: "okx", displayName: "OKX", supportsRealExecution: hasKeys,

    async verify() {
      try {
        if (!hasKeys) { await publicGet("/api/v5/public/time"); return { ok: true, message: "Public only" }; }
        const r = await signed<{ code: string; msg: string }>("GET", "/api/v5/account/balance");
        return { ok: r.code === "0", message: r.msg };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasKeys) return [];
      const r = await signed<{ data: Array<{ details: Array<{ ccy: string; eq: string; availEq: string }> }> }>("GET", "/api/v5/account/balance");
      return (r.data?.[0]?.details ?? []).map(d => ({
        currency: d.ccy, total: Number(d.eq || 0), available: Number(d.availEq || d.eq || 0),
      })).filter(b => b.total > 0);
    },

    async getQuote(symbol: string): Promise<Quote> {
      const s = toOkx(symbol);
      const r = await publicGet<{ data: Array<{ instId: string; bidPx: string; askPx: string; last: string }> }>(
        `/api/v5/market/ticker?instId=${s}`,
      );
      const t = r.data?.[0];
      if (!t) throw new Error(`No ticker for ${s}`);
      const bid = Number(t.bidPx), ask = Number(t.askPx);
      return { symbol, bid, ask, mid: (bid + ask) / 2 || Number(t.last), ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      const body: Record<string, unknown> = {
        instId: toOkx(input.symbol), tdMode: "cash",
        side: input.side, ordType: input.orderType === "market" ? "market" : "limit",
        sz: String(input.qty),
        ...(input.limitPrice ? { px: String(input.limitPrice) } : {}),
        ...(input.clientOrderId ? { clOrdId: input.clientOrderId } : {}),
      };
      const r = await signed<{ code: string; msg: string; data: Array<{ ordId: string; clOrdId: string; sCode: string; sMsg: string }> }>(
        "POST", "/api/v5/trade/order", body,
      );
      const row = r.data?.[0];
      if (r.code !== "0" || !row || row.sCode !== "0") {
        throw new Error(`OKX rejected: ${row?.sMsg ?? r.msg}`);
      }
      return {
        externalOrderId: row.ordId, clientOrderId: row.clOrdId,
        status: "working", fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
      };
    },

    async cancelOrder(externalOrderId: string, symbol?: string) {
      if (!symbol) return { ok: false };
      const r = await signed<{ code: string }>("POST", "/api/v5/trade/cancel-order", {
        instId: toOkx(symbol), ordId: externalOrderId,
      });
      return { ok: r.code === "0" };
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasKeys) return [];
      try {
        const r = await signed<{ data: Array<{ instId: string; pos: string; avgPx: string }> }>("GET", "/api/v5/account/positions");
        return (r.data ?? []).filter(p => Number(p.pos) !== 0).map(p => ({
          symbol: p.instId, qty: Number(p.pos), avgEntry: Number(p.avgPx),
        }));
      } catch { return []; }
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasKeys) return [];
      const r = await signed<{ data: Array<{ ordId: string; instId: string; side: string; fillSz: string; fillPx: string; fee: string; ts: string }> }>(
        "GET", `/api/v5/trade/fills?limit=${limit}`,
      );
      return (r.data ?? []).map(x => ({
        externalOrderId: x.ordId, symbol: x.instId,
        side: x.side === "buy" ? "buy" : "sell",
        qty: Number(x.fillSz), price: Number(x.fillPx),
        fees: Math.abs(Number(x.fee)), ts: Number(x.ts),
      }));
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        const r = await publicGet<{ data: Array<{ ts: string }> }>("/api/v5/public/time");
        const latency = Date.now() - t0;
        const skew = r.data?.[0]?.ts ? Number(r.data[0].ts) - Date.now() : null;
        return { ok: true, pingLatencyMs: latency, clockSkewMs: skew };
      } catch (e) { return { ok: false, pingLatencyMs: null, clockSkewMs: null, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      if (!hasKeys) return { enableReading: false, enableSpotAndMarginTrading: false, enableWithdrawals: false };
      try {
        const r = await signed<{ data: Array<{ perm: string; ip: string }> }>("GET", "/api/v5/users/subaccount/apikey");
        const perms = new Set((r.data?.[0]?.perm ?? "").split(",").map(p => p.trim().toLowerCase()));
        return {
          ipRestrict: Boolean(r.data?.[0]?.ip),
          enableReading: perms.has("read_only") || perms.has("read"),
          enableSpotAndMarginTrading: perms.has("trade"),
          enableWithdrawals: perms.has("withdraw"),
          raw: r.data,
        };
      } catch { return { enableReading: true, enableSpotAndMarginTrading: false, enableWithdrawals: false }; }
    },
  };
}
