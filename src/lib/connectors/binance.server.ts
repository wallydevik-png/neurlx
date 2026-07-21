// Production Binance connector. Supports READ + real spot trading (market,
// limit, stop-loss-limit, take-profit-limit) with idempotent clientOrderId,
// exchange-filter enforcement, and full request/response logging.
//
// Safety invariants live upstream in engine.server.ts + preTradeCheck.server.ts;
// this file only exposes primitives. It never bypasses the risk gate itself
// because it never *calls* itself — the engine does.
//
// Runs on the Cloudflare Worker runtime (Web Crypto only, no Node crypto).
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, OrderStatusResult, OrderStatus, PlaceOrderInput,
  PlaceOrderResult, Quote, SymbolFilter, TradingConnector,
} from "./types";
import { logApiRequest } from "@/lib/execution/requestLog.server";

const BASE = "https://api.binance.com";

// -------- symbol translation --------
function toBinance(symbol: string): string {
  if (!symbol.includes("-")) return symbol.toUpperCase();
  const [base, quote] = symbol.toUpperCase().split("-");
  const q = quote === "USD" ? "USDT" : quote;
  return `${base}${q}`;
}
function fromBinance(binanceSymbol: string): string {
  // Best-effort: BTCUSDT -> BTC-USD. If ends with USDT/USDC/BUSD -> USD.
  const stables = ["USDT", "USDC", "BUSD", "FDUSD"];
  for (const s of stables) {
    if (binanceSymbol.endsWith(s)) {
      return `${binanceSymbol.slice(0, -s.length)}-USD`;
    }
  }
  return binanceSymbol;
}

// -------- signing --------
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// -------- error classification --------
export interface BinanceApiError extends Error {
  code?: number;
  httpStatus?: number;
  retryable: boolean;
  duplicateOrder?: boolean;
}
function classifyError(status: number, body: string): BinanceApiError {
  let code: number | undefined;
  let msg = body;
  try {
    const j = JSON.parse(body) as { code?: number; msg?: string };
    code = j.code; msg = j.msg ?? body;
  } catch { /* ignore */ }
  const err = new Error(`Binance error [${status}${code !== undefined ? `/${code}` : ""}]: ${msg}`) as BinanceApiError;
  err.httpStatus = status;
  err.code = code;
  // Binance -1003 = rate limit; -1015 = too many new orders; 5xx = server
  err.retryable = status >= 500 || status === 429 || code === -1003 || code === -1015;
  // -2010 = order rejected (often includes duplicate clientOrderId)
  err.duplicateOrder = code === -2010 && /duplicate|already exists/i.test(msg);
  return err;
}

// -------- exchangeInfo cache --------
interface ExchangeInfoCache { at: number; symbols: Map<string, SymbolFilter> }
let exchangeInfoCache: ExchangeInfoCache | null = null;
async function loadExchangeInfo(): Promise<Map<string, SymbolFilter>> {
  if (exchangeInfoCache && Date.now() - exchangeInfoCache.at < 60 * 60 * 1000) {
    return exchangeInfoCache.symbols;
  }
  const res = await fetch(`${BASE}/api/v3/exchangeInfo`);
  if (!res.ok) throw new Error(`exchangeInfo ${res.status}`);
  const j = await res.json() as { symbols: Array<{
    symbol: string; filters: Array<Record<string, string>>;
  }> };
  const m = new Map<string, SymbolFilter>();
  for (const s of j.symbols) {
    let minQty = 0, stepSize = 0, tickSize = 0, minNotional = 0;
    for (const f of s.filters) {
      if (f.filterType === "LOT_SIZE") {
        minQty = Number(f.minQty); stepSize = Number(f.stepSize);
      } else if (f.filterType === "PRICE_FILTER") {
        tickSize = Number(f.tickSize);
      } else if (f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") {
        minNotional = Number(f.minNotional ?? f.notional ?? 0);
      }
    }
    m.set(s.symbol, { minQty, stepSize, tickSize, minNotional });
  }
  exchangeInfoCache = { at: Date.now(), symbols: m };
  return m;
}

function roundToStep(v: number, step: number): number {
  if (!step) return v;
  return Math.floor(v / step) * step;
}
function formatDecimal(v: number, step: number): string {
  if (!step) return String(v);
  const decimals = Math.max(0, Math.round(-Math.log10(step)));
  return v.toFixed(decimals);
}

// -------- factory --------
export interface BinanceContext {
  supabase?: SupabaseClient;
  userId?: string;
  connectionId?: string | null;
  orderId?: string | null;
}

export function createBinanceConnector(
  credentials: Record<string, string>,
  ctx: BinanceContext = {},
): TradingConnector {
  const apiKey = credentials.apiKey ?? "";
  const apiSecret = credentials.apiSecret ?? "";
  const hasKeys = Boolean(apiKey && apiSecret);
  const venue = "binance";

  async function log(
    method: string, path: string, params: Record<string, unknown>,
    signed: boolean, started: number, res?: Response, body?: string, err?: unknown,
  ) {
    if (!ctx.supabase || !ctx.userId) return;
    await logApiRequest(ctx.supabase, {
      userId: ctx.userId,
      connectionId: ctx.connectionId ?? null,
      orderId: ctx.orderId ?? null,
      venue, method, path,
      statusCode: res?.status ?? null,
      latencyMs: Date.now() - started,
      params,
      responseSnippet: body ?? null,
      error: err ? (err instanceof Error ? err.message : String(err)) : null,
      isSigned: signed,
    });
  }

  async function publicGet<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = `${BASE}${path}${params ? "?" + new URLSearchParams(params).toString() : ""}`;
    const started = Date.now();
    let res: Response | undefined;
    let text = "";
    try {
      res = await fetch(url);
      text = await res.text();
      if (!res.ok) throw classifyError(res.status, text);
      await log("GET", path, params ?? {}, false, started, res, text.slice(0, 500));
      return JSON.parse(text) as T;
    } catch (e) {
      await log("GET", path, params ?? {}, false, started, res, text.slice(0, 500), e);
      throw e;
    }
  }

  async function signed<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    if (!hasKeys) throw new Error("API keys required for signed endpoint");
    const qs = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      timestamp: String(Date.now()),
      recvWindow: "5000",
    }).toString();
    const sig = await hmacSha256Hex(apiSecret, qs);
    const url = `${BASE}${path}?${qs}&signature=${sig}`;
    const started = Date.now();
    let res: Response | undefined;
    let text = "";
    try {
      res = await fetch(url, { method, headers: { "X-MBX-APIKEY": apiKey } });
      text = await res.text();
      if (!res.ok) throw classifyError(res.status, text);
      await log(method, path, params, true, started, res, text.slice(0, 500));
      return JSON.parse(text) as T;
    } catch (e) {
      await log(method, path, params, true, started, res, text.slice(0, 500), e);
      throw e;
    }
  }

  // ---- interface impl ----
  const connector: TradingConnector = {
    id: "binance",
    displayName: "Binance",
    supportsRealExecution: true,

    async verify() {
      try {
        await publicGet("/api/v3/ping");
      } catch {
        return { ok: false, message: "Binance unreachable" };
      }
      if (!hasKeys) return { ok: true, message: "Public market data reachable. No API key — trading unavailable." };
      try {
        await signed("GET", "/api/v3/account", {});
        return { ok: true, message: "Read access verified." };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Key verification failed" };
      }
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const started = Date.now();
      try {
        await publicGet<{}>("/api/v3/ping");
        const pingMs = Date.now() - started;
        const t = await publicGet<{ serverTime: number }>("/api/v3/time");
        const skew = t.serverTime - Date.now();
        return {
          ok: true, pingLatencyMs: pingMs, clockSkewMs: skew,
          message: `ping ${pingMs}ms · skew ${skew}ms`,
        };
      } catch (e) {
        return { ok: false, pingLatencyMs: null, clockSkewMs: null,
          message: e instanceof Error ? e.message : "Unreachable" };
      }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      if (!hasKeys) throw new Error("API keys required");
      const p = await signed<Record<string, unknown>>(
        "GET", "/sapi/v1/account/apiRestrictions", {},
      );
      return {
        ipRestrict: Boolean(p.ipRestrict),
        enableReading: Boolean(p.enableReading),
        enableSpotAndMarginTrading: Boolean(p.enableSpotAndMarginTrading),
        enableWithdrawals: Boolean(p.enableWithdrawals),
        enableInternalTransfer: Boolean(p.enableInternalTransfer),
        enableMargin: Boolean(p.enableMargin),
        enableFutures: Boolean(p.enableFutures),
        tradingAuthorityExpirationTime: (p.tradingAuthorityExpirationTime as number) ?? null,
        raw: p,
      };
    },

    async getSymbolFilter(symbol) {
      const m = await loadExchangeInfo();
      return m.get(toBinance(symbol)) ?? null;
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasKeys) return [];
      const acct = await signed<{
        balances: { asset: string; free: string; locked: string }[];
      }>("GET", "/api/v3/account", {});
      return acct.balances
        .map(b => ({
          currency: b.asset,
          total: Number(b.free) + Number(b.locked),
          available: Number(b.free),
        }))
        .filter(b => b.total > 0);
    },

    async getQuote(symbol) {
      const s = toBinance(symbol);
      const [ticker, book] = await Promise.all([
        publicGet<{ price: string }>("/api/v3/ticker/price", { symbol: s }),
        publicGet<{ bidPrice: string; askPrice: string }>("/api/v3/ticker/bookTicker", { symbol: s }),
      ]);
      const mid = Number(ticker.price);
      return {
        symbol, mid,
        bid: Number(book.bidPrice) || mid,
        ask: Number(book.askPrice) || mid,
        ts: Date.now(),
      };
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasKeys) return [];
      const balances = await this.getBalances();
      return balances
        .filter(b => b.currency !== "USDT" && b.currency !== "USD" && b.total > 0)
        .map(b => ({ symbol: `${b.currency}-USD`, qty: b.total, avgEntry: 0 }));
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasKeys) return [];
      const balances = await this.getBalances();
      const top = balances
        .filter(b => b.currency !== "USDT" && b.currency !== "USD")
        .sort((a, b) => b.total - a.total)[0];
      if (!top) return [];
      const symbol = `${top.currency}USDT`;
      const trades = await signed<{
        id: number; price: string; qty: string; commission: string;
        commissionAsset: string; time: number; isBuyer: boolean;
      }[]>("GET", "/api/v3/myTrades", { symbol, limit });
      return trades.map(t => ({
        externalOrderId: String(t.id),
        symbol: `${top.currency}-USD`,
        side: t.isBuyer ? "buy" : "sell",
        qty: Number(t.qty), price: Number(t.price),
        fees: Number(t.commission), ts: t.time,
      }));
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      if (!hasKeys) throw new Error("API keys required to place orders");
      const symbol = toBinance(input.symbol);
      const filters = await loadExchangeInfo();
      const f = filters.get(symbol);
      if (!f) throw new Error(`Unknown symbol ${symbol} on Binance`);

      // Enforce filters
      const qty = roundToStep(input.qty, f.stepSize);
      if (qty < f.minQty) {
        throw new Error(`Quantity ${qty} below Binance minimum ${f.minQty} for ${symbol}`);
      }
      const params: Record<string, string | number> = {
        symbol,
        side: input.side.toUpperCase(),
        quantity: formatDecimal(qty, f.stepSize),
      };
      if (input.clientOrderId) params.newClientOrderId = input.clientOrderId;

      // Map order type
      const t = input.orderType;
      if (t === "market") {
        params.type = "MARKET";
      } else if (t === "limit") {
        if (!input.limitPrice) throw new Error("limit_price required for LIMIT order");
        params.type = "LIMIT";
        params.timeInForce = "GTC";
        params.price = formatDecimal(roundToStep(input.limitPrice, f.tickSize), f.tickSize);
      } else if (t === "stop_loss_limit" || t === "take_profit_limit") {
        if (!input.limitPrice || !input.stopPrice) {
          throw new Error("stop_price and limit_price required");
        }
        params.type = t === "stop_loss_limit" ? "STOP_LOSS_LIMIT" : "TAKE_PROFIT_LIMIT";
        params.timeInForce = "GTC";
        params.stopPrice = formatDecimal(roundToStep(input.stopPrice, f.tickSize), f.tickSize);
        params.price = formatDecimal(roundToStep(input.limitPrice, f.tickSize), f.tickSize);
      }

      if (input.limitPrice && f.minNotional && qty * input.limitPrice < f.minNotional) {
        throw new Error(`Notional ${(qty * input.limitPrice).toFixed(2)} below Binance minimum ${f.minNotional}`);
      }

      const started = Date.now();
      let raw: Record<string, unknown>;
      try {
        raw = await signed<Record<string, unknown>>("POST", "/api/v3/order", params);
      } catch (e) {
        const be = e as BinanceApiError;
        if (be.duplicateOrder && input.clientOrderId) {
          // Idempotency: fetch the existing order.
          raw = await signed<Record<string, unknown>>(
            "GET", "/api/v3/order",
            { symbol, origClientOrderId: input.clientOrderId },
          );
        } else {
          throw e;
        }
      }
      const latencyMs = Date.now() - started;

      const status = mapBinanceStatus(String(raw.status ?? ""));
      const executedQty = Number(raw.executedQty ?? 0);
      const cumQuote = Number(raw.cummulativeQuoteQty ?? 0);
      const avgPrice = executedQty > 0 ? cumQuote / executedQty : Number(raw.price ?? 0);
      const fills = (raw.fills ?? []) as { commission?: string; commissionAsset?: string }[];
      const fees = fills.reduce((s, x) => s + Number(x.commission ?? 0), 0);
      const feeCurrency = fills[0]?.commissionAsset;

      const refPrice = Number(raw.price ?? avgPrice ?? 0) || avgPrice;
      const slippageBps = refPrice > 0 && avgPrice > 0
        ? Math.round(((avgPrice - refPrice) / refPrice) * 10_000) * (input.side === "buy" ? 1 : -1)
        : 0;

      return {
        externalOrderId: String(raw.orderId ?? ""),
        clientOrderId: String(raw.clientOrderId ?? input.clientOrderId ?? ""),
        status,
        filledPrice: avgPrice || undefined,
        filledQty: executedQty || undefined,
        fees,
        feeCurrency,
        slippageBps,
        latencyMs,
        raw,
      };
    },

    async cancelOrder(externalOrderId, symbol) {
      if (!hasKeys) throw new Error("API keys required");
      if (!symbol) throw new Error("symbol required to cancel Binance order");
      await signed("DELETE", "/api/v3/order", {
        symbol: toBinance(symbol),
        orderId: externalOrderId,
      });
      return { ok: true };
    },

    async getOrderStatus(externalOrderId, symbol, clientOrderId): Promise<OrderStatusResult> {
      const params: Record<string, string | number> = { symbol: toBinance(symbol) };
      if (clientOrderId) params.origClientOrderId = clientOrderId;
      else params.orderId = externalOrderId;
      const raw = await signed<Record<string, unknown>>("GET", "/api/v3/order", params);
      const executedQty = Number(raw.executedQty ?? 0);
      const cumQuote = Number(raw.cummulativeQuoteQty ?? 0);
      return {
        externalOrderId: String(raw.orderId ?? externalOrderId),
        clientOrderId: raw.clientOrderId ? String(raw.clientOrderId) : undefined,
        status: mapBinanceStatus(String(raw.status ?? "")),
        filledQty: executedQty,
        cumulativeQuoteQty: cumQuote,
        avgPrice: executedQty > 0 ? cumQuote / executedQty : 0,
        fees: 0, // fetched separately from /myTrades if needed
        updatedAt: Number(raw.updateTime ?? Date.now()),
      };
    },
  };

  return connector;
}

function mapBinanceStatus(s: string): OrderStatus {
  switch (s) {
    case "NEW": case "PENDING_NEW": case "PENDING_CANCEL": return "working";
    case "PARTIALLY_FILLED": return "partially_filled";
    case "FILLED": return "filled";
    case "CANCELED": case "EXPIRED": return "cancelled";
    case "REJECTED": return "rejected";
    default: return "pending";
  }
}

export { fromBinance };
