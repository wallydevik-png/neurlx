// Production MetaTrader connector — routed through the official MetaApi cloud
// bridge (https://metaapi.cloud/docs/). MetaApi is the MetaQuotes-approved
// gateway that lets server code talk to any broker's MT4/MT5 terminal.
//
// Every MT-only broker in the NeurlX registry (Octa, Exness, IC Markets,
// Pepperstone, FP Markets, XM, MT5, MT4) uses this exact connector. The
// broker is only cosmetic — the transport is one universal bridge.
//
// Credential shapes accepted (in priority order):
//   1. Bring-your-own: { metaApiToken, accountId, region? }
//   2. Native MT (auto-provisioned): { login, password, server, region? }
//      + workspace env METAAPI_TOKEN
//
// When shape #2 is used and no accountId exists yet, the connector calls
// MetaApi's provisioning API to create + deploy the account, then persists
// the returned accountId back into the encrypted credential blob so future
// calls skip provisioning.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ApiPermissionSnapshot, Balance, ConnectionHealth, ConnectorPosition,
  HistoryEntry, PlaceOrderInput, PlaceOrderResult, Quote, TradingConnector,
} from "./types";
import { doRequest } from "./rest.server";

const PROVISIONING_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
function clientBaseFor(region: string): string {
  const r = region || "new-york";
  return `https://mt-client-api-v1.${r}.agiliumtrade.ai`;
}
/** Strip separators/case so "BTC-USD", "btc/usd" and "BTCUSD" compare equal. */
function normalizeKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
/** Broker suffixes/prefixes seen in the wild: BTCUSD.m, BTCUSD_raw, #BTCUSD, BTCUSDm */
function stripDecorations(mtSymbol: string): string[] {
  const base = normalizeKey(mtSymbol);
  const out = new Set<string>([base]);
  out.add(base.replace(/(MICRO|CASH|RAW|ECN|PRO|STP|SB|M|C|Z|I|E|R)$/, ""));
  out.add(base.replace(/^(FX|CFD)/, ""));
  return [...out].filter(Boolean);
}
/** Quote-currency aliases: many venues list USDT/USD interchangeably. */
function candidatesFor(symbol: string): string[] {
  const k = normalizeKey(symbol);
  const c = new Set<string>([k]);
  if (k.endsWith("USD")) { c.add(k + "T"); c.add(k.slice(0, -3) + "USDT"); }
  if (k.endsWith("USDT")) c.add(k.slice(0, -1));
  return [...c];
}
export class UnsupportedSymbolError extends Error {
  readonly unsupportedSymbol: string;
  constructor(symbol: string, venue: string) {
    super(`Symbol ${symbol} is not available on ${venue} — trade skipped.`);
    this.name = "UnsupportedSymbolError";
    this.unsupportedSymbol = symbol;
  }
}
function isMt4(brokerId: string): boolean {
  return brokerId === "mt4";
}

/** Every MetaApi action NeurlX can emit. */
export const MT_ACTIONS = {
  buy_market: "ORDER_TYPE_BUY",
  sell_market: "ORDER_TYPE_SELL",
  buy_limit: "ORDER_TYPE_BUY_LIMIT",
  sell_limit: "ORDER_TYPE_SELL_LIMIT",
  buy_stop: "ORDER_TYPE_BUY_STOP",
  sell_stop: "ORDER_TYPE_SELL_STOP",
} as const;
export type MtAction = (typeof MT_ACTIONS)[keyof typeof MT_ACTIONS];

/** Normalize any AI/committee side or order-type wording into a MetaApi action. */
export function resolveTradeAction(
  side: string | undefined,
  orderType: string | undefined,
): MtAction {
  const s = String(side ?? "").toLowerCase().trim();
  const t = String(orderType ?? "market").toLowerCase().trim();

  // Some upstream signals encode direction inside orderType ("buy_limit").
  const combined = `${s}_${t}`;
  const direction = /sell|short|bearish/.test(combined) ? "sell"
    : /buy|long|bullish/.test(combined) ? "buy"
    : null;
  if (!direction) throw new Error(`Unknown trade direction "${side}" (orderType "${orderType}")`);

  const kind = /stop_loss_limit|take_profit_limit|limit/.test(t) ? "limit"
    : /stop/.test(t) ? "stop"
    : "market";

  const action = kind === "limit"
    ? (direction === "buy" ? MT_ACTIONS.buy_limit : MT_ACTIONS.sell_limit)
    : kind === "stop"
      ? (direction === "buy" ? MT_ACTIONS.buy_stop : MT_ACTIONS.sell_stop)
      : (direction === "buy" ? MT_ACTIONS.buy_market : MT_ACTIONS.sell_market);
  return action;
}

/**
 * MetaApi validates clientId against ^[a-zA-Z0-9_]+$ with a max length of 24
 * (the value is forwarded to the terminal comment field). Our internal ids look
 * like "hlx_d7c4be3c525a4a7dae692d48c551" — too long, so MetaApi rejects them.
 * We sanitize and truncate; if nothing valid remains we omit the field entirely
 * (it is optional and MetaApi will generate its own).
 */
export const MT_CLIENT_ID_PATTERN = /^[a-zA-Z0-9_]{1,24}$/;

export function sanitizeClientId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 24);
  if (!cleaned) return undefined;
  return MT_CLIENT_ID_PATTERN.test(cleaned) ? cleaned : undefined;
}

/** Build + validate the exact JSON body MetaApi's /trade endpoint expects. */
export function buildTradeRequest(
  input: PlaceOrderInput,
  mtSymbol: string,
): Record<string, unknown> {
  const actionType = resolveTradeAction(input.side, input.orderType);
  if (!actionType) throw new Error(`Refusing to submit MT trade with undefined action for ${mtSymbol}`);
  const volume = Number(input.qty);
  if (!(volume > 0)) throw new Error(`Invalid MT volume ${input.qty} for ${mtSymbol}`);
  const isPending = actionType !== MT_ACTIONS.buy_market && actionType !== MT_ACTIONS.sell_market;
  if (isPending && !(Number(input.limitPrice) > 0)) {
    throw new Error(`Pending order on ${mtSymbol} requires a positive openPrice`);
  }
  const clientId = sanitizeClientId(input.clientOrderId);
  return {
    actionType,
    symbol: mtSymbol,
    volume,
    ...(isPending && input.limitPrice ? { openPrice: Number(input.limitPrice) } : {}),
    ...(input.stopPrice ? { stopLoss: Number(input.stopPrice) } : {}),
    ...(clientId ? { clientId } : {}),
  };
}


async function persistCredentials(
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null },
  updated: Record<string, string>,
): Promise<void> {
  if (!ctx.supabase || !ctx.connectionId || !ctx.userId) return;
  try {
    const { encryptJSON } = await import("@/lib/crypto.server");
    const ciphertext = await encryptJSON(updated);
    await ctx.supabase.from("exchange_connections")
      .update({ credential_ciphertext: ciphertext, last_sync_at: new Date().toISOString() })
      .eq("id", ctx.connectionId).eq("user_id", ctx.userId);
  } catch {
    // Non-fatal — provisioning still succeeded, next call will re-provision.
  }
}

async function provisionAccount(params: {
  token: string; brokerId: string; login: string; password: string;
  server: string; region: string; name: string;
}): Promise<string> {
  const platform = isMt4(params.brokerId) ? "mt4" : "mt5";
  const res = await fetch(`${PROVISIONING_BASE}/users/current/accounts`, {
    method: "POST",
    headers: { "auth-token": params.token, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: params.name.slice(0, 60),
      type: "cloud-g2",
      login: params.login,
      password: params.password,
      server: params.server,
      platform,
      magic: 0,
      application: "MetaApi",
      region: params.region,
      keywords: ["NeurlX"],
      reliability: "high",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`MetaApi provisioning failed (${res.status}): ${text.slice(0, 240)}`);
  }
  let parsed: { id?: string };
  try { parsed = JSON.parse(text); } catch { throw new Error("MetaApi provisioning returned non-JSON"); }
  if (!parsed.id) throw new Error("MetaApi provisioning did not return an account id");
  // Best-effort deploy — safe to retry, idempotent server-side.
  await fetch(`${PROVISIONING_BASE}/users/current/accounts/${parsed.id}/deploy`, {
    method: "POST", headers: { "auth-token": params.token },
  }).catch(() => undefined);
  return parsed.id;
}

export function createMt5Connector(
  brokerId: string,
  credentials: Record<string, string>,
  ctx: { supabase?: SupabaseClient; userId?: string; connectionId?: string | null; orderId?: string | null } = {},
): TradingConnector {
  const state = {
    token: credentials.metaApiToken ?? credentials.accessToken ?? process.env.METAAPI_TOKEN ?? "",
    accountId: credentials.accountId ?? credentials.mtAccountId ?? "",
    region: credentials.region ?? "new-york",
    login: credentials.login ?? credentials.accountNumber ?? "",
    password: credentials.password ?? "",
    server: credentials.server ?? credentials.brokerServer ?? "",
  };
  const logCtx = { ...ctx, venue: `mt5:${brokerId}` };
  const label = brokerId === "mt5" || brokerId === "mt4"
    ? "MetaTrader" : `${brokerId.toUpperCase()} · MetaTrader 5`;
  const canProvision = () => Boolean(state.token && state.login && state.password && state.server);
  const isReady = () => Boolean(state.token && state.accountId);

  async function ensureReady(): Promise<void> {
    if (isReady()) return;
    if (!state.token) {
      throw new Error(
        "MetaApi bridge unavailable — set the METAAPI_TOKEN workspace secret (or provide a per-connection metaApiToken) so NeurlX can reach your MT account.",
      );
    }
    if (state.accountId) return;
    if (!canProvision()) {
      throw new Error(
        "Missing MT credentials — provide login, password, and server (or an existing MetaApi accountId).",
      );
    }
    state.accountId = await provisionAccount({
      token: state.token, brokerId,
      login: state.login, password: state.password,
      server: state.server, region: state.region,
      name: `NeurlX ${brokerId.toUpperCase()} ${state.login}`,
    });
    await persistCredentials(ctx, {
      ...credentials,
      metaApiToken: credentials.metaApiToken ?? "", // keep BYO field if user supplied
      accountId: state.accountId,
      region: state.region,
      login: state.login,
      password: state.password,
      server: state.server,
    });
  }

  async function req<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    await ensureReady();
    const base = clientBaseFor(state.region);
    return doRequest<T>({
      ctx: logCtx, method, path, url: `${base}${path}`,
      headers: { "auth-token": state.token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      params: body as Record<string, unknown> | undefined, signed: true,
    });
  }

  // ---- Broker symbol map -------------------------------------------------
  // MetaApi exposes the exact instrument names the connected broker offers
  // (they differ per broker: BTCUSD, BTCUSD.m, BTCUSDT, #BTCUSD ...). We pull
  // them once per connector instance and resolve every requested symbol
  // against that list, so nothing unsupported ever reaches MetaApi.
  let symbolMapPromise: Promise<Map<string, string>> | null = null;

  async function loadSymbolMap(): Promise<Map<string, string>> {
    const list = await req<string[]>(
      "GET", `/users/current/accounts/${state.accountId}/symbols`,
    );
    const map = new Map<string, string>();
    for (const s of list ?? []) {
      for (const key of stripDecorations(s)) {
        if (!map.has(key)) map.set(key, s);
      }
      map.set(normalizeKey(s), s); // exact name always wins
    }
    return map;
  }

  async function getSymbolMap(): Promise<Map<string, string>> {
    if (!symbolMapPromise) {
      symbolMapPromise = loadSymbolMap().catch((e) => {
        symbolMapPromise = null;
        throw e;
      });
    }
    return symbolMapPromise;
  }

  /** Returns the broker's exact instrument name, or throws UnsupportedSymbolError. */
  async function resolveSymbol(symbol: string): Promise<string> {
    const map = await getSymbolMap();
    for (const candidate of candidatesFor(symbol)) {
      const hit = map.get(candidate);
      if (hit) return hit;
    }
    throw new UnsupportedSymbolError(symbol, label);
  }

  return {
    id: brokerId, displayName: label,
    supportsRealExecution: canProvision() || isReady(),

    async verify() {
      try {
        await ensureReady();
        const r = await req<{ balance: number; currency: string }>(
          "GET", `/users/current/accounts/${state.accountId}/accountInformation`,
        );
        return { ok: Number.isFinite(r.balance), message: `${r.currency} ${r.balance}` };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // MetaApi returns 404 for a few seconds while the terminal boots.
        if (/not found|not deployed|initializing|not connected/i.test(msg)) {
          return { ok: true, message: "MT account provisioning — first sync may take up to 5 minutes." };
        }
        return { ok: false, message: msg };
      }
    },

    async getBalances(): Promise<Balance[]> {
      try {
        const r = await req<{ balance: number; equity: number; currency: string; freeMargin: number }>(
          "GET", `/users/current/accounts/${state.accountId}/accountInformation`,
        );
        return [{ currency: r.currency, total: r.equity, available: r.freeMargin }];
      } catch { return []; }
    },

    async getQuote(symbol: string): Promise<Quote> {
      const s = await resolveSymbol(symbol);
      const r = await req<{ bid: number; ask: number }>(
        "GET", `/users/current/accounts/${state.accountId}/symbols/${encodeURIComponent(s)}/current-price`,
      );
      return { symbol, bid: r.bid, ask: r.ask, mid: (r.bid + r.ask) / 2, ts: Date.now() };
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      // Throws UnsupportedSymbolError for instruments the broker doesn't list,
      // so the caller skips the trade instead of submitting a bad request.
      const mtSymbol = await resolveSymbol(input.symbol);

      // Normalizes any committee wording (buy/sell/long/short, market/limit/stop)
      // into a valid MetaApi action and validates before submitting.
      const body = buildTradeRequest(input, mtSymbol);
      const actionType = body.actionType as string;

      // Exact request body logged before the call (secrets are not part of it).
      console.log("[MT5] trade request", JSON.stringify({
        accountId: state.accountId, requestedSymbol: input.symbol, body,
      }));

      // MetaApi's REST /trade endpoint takes the trade object at the top level.
      const r = await req<{ orderId: string; positionId?: string; numericCode: number; stringCode: string; message?: string }>(
        "POST", `/users/current/accounts/${state.accountId}/trade`, body,
      );
      const success = r.stringCode === "TRADE_RETCODE_DONE" || r.numericCode === 10009;
      if (!success) {
        throw new Error(
          `MT trade rejected on ${mtSymbol}: ${r.stringCode ?? "unknown"} (${r.numericCode ?? "?"})${r.message ? " — " + r.message : ""}`,
        );
      }
      return {
        externalOrderId: r.positionId ?? r.orderId,
        clientOrderId: input.clientOrderId,
        status: actionType === MT_ACTIONS.buy_market || actionType === MT_ACTIONS.sell_market
          ? "filled" : "working",
        fees: 0, slippageBps: 0, latencyMs: Date.now() - started,
        // Surfaces the exact broker instrument in the execution log.
        raw: { mtSymbol, actionType, requestedSymbol: input.symbol, request: body, response: r },
      };
    },


    async cancelOrder(externalOrderId: string) {
      try {
        await req<void>("POST", `/users/current/accounts/${state.accountId}/trade`, {
          actionType: "POSITION_CLOSE_ID", positionId: externalOrderId,
        });
        return { ok: true };
      } catch { return { ok: false }; }
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      try {
        const r = await req<Array<{ symbol: string; volume: number; type: string; openPrice: number }>>(
          "GET", `/users/current/accounts/${state.accountId}/positions`,
        );
        return (r ?? []).map(p => ({
          symbol: p.symbol,
          qty: p.type === "POSITION_TYPE_SELL" ? -p.volume : p.volume,
          avgEntry: p.openPrice,
        }));
      } catch { return []; }
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      try {
        const end = new Date().toISOString();
        const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const r = await req<Array<{ id: string; symbol: string; type: string; volume: number; price: number; commission: number; time: string }>>(
          "GET", `/users/current/accounts/${state.accountId}/history-deals/time/${start}/${end}?limit=${limit}`,
        );
        return (r ?? []).map(d => ({
          externalOrderId: d.id, symbol: d.symbol,
          side: d.type === "DEAL_TYPE_SELL" ? "sell" : "buy",
          qty: d.volume, price: d.price,
          fees: Math.abs(d.commission ?? 0), ts: new Date(d.time).getTime(),
        }));
      } catch { return []; }
    },

    async checkHealth(): Promise<ConnectionHealth> {
      const t0 = Date.now();
      try {
        await req<unknown>("GET", `/users/current/accounts/${state.accountId}/accountInformation`);
        return { ok: true, pingLatencyMs: Date.now() - t0, clockSkewMs: 0 };
      } catch (e) {
        return {
          ok: false, pingLatencyMs: null, clockSkewMs: null,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },

    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      // MT permissions are set on the trading account, not on the API token —
      // investor password = read-only, trading password = read + trade.
      // Withdrawals are never performed via the trading protocol.
      const canTrade = canProvision() || isReady();
      return {
        enableReading: canTrade, enableSpotAndMarginTrading: canTrade, enableWithdrawals: false,
      };
    },
  };
}
