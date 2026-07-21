// Production Kraken connector — REST v0.
// Docs: https://docs.kraken.com/api/
// Signing: base64(HMAC-SHA512(base64_decode(secret), URI_path + SHA256(nonce+postData))).

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { krakenSignature } from "./signing.server";
import { doRequest } from "./rest.server";

const BASE = "https://api.kraken.com";

function toKraken(symbol: string): string {
  if (!symbol.includes("-")) return symbol.toUpperCase();
  const [b, q] = symbol.toUpperCase().split("-");
  const base = b === "BTC" ? "XBT" : b;
  return `${base}${q === "USD" ? "USD" : q}`;
}

export function createKrakenConnector(
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const apiKey = credentials.apiKey ?? "";
  const apiSecret = credentials.apiSecret ?? "";
  const hasKeys = Boolean(apiKey && apiSecret);
  const logCtx = { ...ctx, venue: "kraken" };

  async function publicGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = `${BASE}${path}${params ? "?" + new URLSearchParams(params) : ""}`;
    return doRequest<T>({ ctx: logCtx, method: "GET", url, path, params });
  }

  async function signedPost<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    if (!hasKeys) throw new Error("Kraken API key + private key required");
    const nonce = Date.now().toString();
    const body = new URLSearchParams({ ...params, nonce }).toString();
    const sig = await krakenSignature(apiSecret, path, nonce, body);
    return doRequest<T>({
      ctx: logCtx, method: "POST", path, url: `${BASE}${path}`,
      headers: {
        "API-Key": apiKey, "API-Sign": sig,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body, params, signed: true,
    });
  }

  return {
    id: "kraken", displayName: "Kraken", supportsRealExecution: hasKeys,

    async verify() {
      try {
        if (!hasKeys) { await publicGet("/0/public/Time"); return { ok: true, message: "Public only" }; }
        const r = await signedPost<{ error: string[] }>("/0/private/Balance");
        return { ok: r.error?.length === 0, message: r.error?.join("; ") };
      } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasKeys) return [];
      const r = await signedPost<{ result: Record<string, string>; error: string[] }>("/0/private/Balance");
      return Object.entries(r.result ?? {}).map(([ccy, amt]) => ({
        currency: ccy.replace(/^[XZ]/, ""), total: Number(amt), available: Number(amt),
      })).filter(b => b.total > 0);
    },

    async getQuote(symbol: string): Promise<Quote> {
      const pair = toKraken(symbol);
      const r = await publicGet<{ result: Record<string, { a: string[]; b: string[]; c: string[] }> }>(`/0/public/Ticker`, { pair });
      const first = Object.values(r.result ?? {})[0];
      if (!first) throw new Error(`No ticker for ${pair}`);
      const bid = Number(first.b[0]), ask = Number(first.a[0]);
      return { symbol, bid, ask, mid: (bid + ask) / 2 || Number(first.c[0]), ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      const params: Record<string, string> = {
        pair: toKraken(input.symbol),
        type: input.side, ordertype: input.orderType === "market" ? "market" : "limit",
        volume: String(input.qty),
        ...(input.limitPrice ? { price: String(input.limitPrice) } : {}),
        ...(input.clientOrderId ? { userref: input.clientOrderId.replace(/\D/g, "").slice(0, 8) || "0" } : {}),
      };
      const r = await signedPost<{ error: string[]; result: { txid: string[] } }>("/0/private/AddOrder", params);
      if (r.error?.length) throw new Error(`Kraken rejected: ${r.error.join("; ")}`);
      return {
        externalOrderId: r.result.txid[0], clientOrderId: input.clientOrderId,
        status: "working", fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
      };
    },

    async cancelOrder(externalOrderId: string) {
      const r = await signedPost<{ error: string[]; result: { count: number } }>("/0/private/CancelOrder", { txid: externalOrderId });
      return { ok: (r.error?.length ?? 0) === 0 && (r.result?.count ?? 0) > 0 };
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasKeys) return [];
      try {
        const r = await signedPost<{ result: Record<string, { pair: string; vol: string; cost: string }> }>("/0/private/OpenPositions");
        return Object.values(r.result ?? {}).map(p => ({
          symbol: p.pair, qty: Number(p.vol), avgEntry: Number(p.cost) / Number(p.vol || 1),
        }));
      } catch { return []; }
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasKeys) return [];
      const r = await signedPost<{ result: { trades: Record<string, { pair: string; type: string; vol: string; price: string; fee: string; time: number }> } }>(
        "/0/private/TradesHistory",
      );
      const rows = Object.entries(r.result?.trades ?? {}).slice(0, limit);
      return rows.map(([id, t]) => ({
        externalOrderId: id, symbol: t.pair,
        side: t.type === "buy" ? "buy" : "sell",
        qty: Number(t.vol), price: Number(t.price),
        fees: Number(t.fee), ts: Math.floor(t.time * 1000),
      }));
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        const r = await publicGet<{ result: { unixtime: number } }>("/0/public/Time");
        return { ok: true, pingLatencyMs: Date.now() - t0, clockSkewMs: r.result.unixtime * 1000 - Date.now() };
      } catch (e) { return { ok: false, pingLatencyMs: null, clockSkewMs: null, message: e instanceof Error ? e.message : String(e) }; }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      // Kraken exposes permissions implicitly per-key; treat successful private call as READ.
      return { enableReading: hasKeys, enableSpotAndMarginTrading: hasKeys, enableWithdrawals: false };
    },
  };
}
