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
  AccountSummary, ApiPermissionSnapshot, Balance, ClosedDeal, ConnectionHealth,
  ConnectorPosition, HistoryEntry, MarginEstimate, PlaceOrderInput, PlaceOrderResult,
  Quote, RichPosition, TradingConnector,
} from "./types";
import { doRequest } from "./rest.server";

const PROVISIONING_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";
function clientBaseFor(region: string): string {
  const r = region || "new-york";
  return `https://mt-client-api-v1.${r}.agiliumtrade.ai`;
}
export function marketDataBaseFor(region: string): string {
  const r = region || "new-york";
  return `https://mt-market-data-client-api-v1.${r}.agiliumtrade.ai`;
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
/** Split "CRV-USD" / "EUR/USD" / "BTCUSDT" into { base, quote } when possible. */
const QUOTES = ["USDT", "USDC", "USD", "EUR", "GBP", "JPY", "AUD", "CHF", "CAD", "NZD", "BTC", "ETH"];
export function splitPair(symbol: string): { base: string; quote: string } | null {
  const raw = symbol.toUpperCase().trim();
  const sep = raw.match(/^([A-Z0-9]+)[-/_ ]([A-Z0-9]+)$/);
  if (sep) return { base: sep[1], quote: sep[2] };
  const k = normalizeKey(raw);
  for (const q of QUOTES) {
    if (k.length > q.length && k.endsWith(q)) return { base: k.slice(0, -q.length), quote: q };
  }
  return null;
}

/** All broker-name candidates for an AI symbol, ordered best-first. */
export function candidatesFor(symbol: string): string[] {
  const k = normalizeKey(symbol);
  const c = new Set<string>([k]);
  const pair = splitPair(symbol);
  if (pair) {
    const { base, quote } = pair;
    const quoteAliases = quote === "USD" ? ["USD", "USDT", "USDC"]
      : quote === "USDT" ? ["USDT", "USD", "USDC"]
        : quote === "USDC" ? ["USDC", "USDT", "USD"]
          : [quote];
    // Some brokers list crypto with an "XBT"/"BTC" alias.
    const baseAliases = base === "BTC" ? ["BTC", "XBT"] : base === "XBT" ? ["XBT", "BTC"] : [base];
    for (const b of baseAliases) for (const q of quoteAliases) c.add(`${b}${q}`);
  }
  if (k.endsWith("USD")) { c.add(k + "T"); c.add(k + "C"); }
  if (k.endsWith("USDT")) c.add(k.slice(0, -1));
  return [...c].filter(Boolean);
}

/** MetaApi timeframe strings for the historical-market-data endpoint. Matches
 *  our internal Interval values 1:1 except we spell it out defensively in
 *  case MetaApi's format ever diverges. */
const MT_TIMEFRAME: Record<string, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d",
};
const MT_TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/** Inverse of splitPair-style logic: turn a raw broker instrument name
 *  ("EURUSD", "BTCUSDm", "XAUUSD.raw") into our "BASE-QUOTE" symbol form
 *  ("EUR-USD", "BTC-USD", "XAU-USD") where a known quote currency can be
 *  identified. Falls back to the cleaned raw name (e.g. "US30") for
 *  instruments that aren't currency/crypto pairs, so indices and other
 *  CFDs still come through instead of being dropped.
 */
export function brokerSymbolToNeurlx(mtSymbol: string): string {
  const cleaned = stripDecorations(mtSymbol)[0] ?? normalizeKey(mtSymbol);
  for (const q of QUOTES) {
    if (cleaned.length > q.length && cleaned.endsWith(q)) {
      const base = cleaned.slice(0, -q.length);
      const quote = q === "USDT" || q === "USDC" ? "USD" : q; // normalize stablecoins to USD form
      return `${base}-${quote}`;
    }
  }
  return cleaned;
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
 * MetaApi's clientId is NOT a free-form string: per
 * https://metaapi.cloud/docs/client/clientIdUsage/ it must follow
 * `${strategyId}_${positionId}_${orderId}` (three alphanumeric parts joined by
 * underscores) and the combined comment+clientId length must be <= 26.
 * Anything else — including our internal "hlx_23e5a02f91ba44c1948b" ids — is
 * rejected with "Invalid value. Value must match required pattern".
 *
 * We therefore build a compliant three-part id from the internal order id, and
 * omit the field entirely when we cannot (it is optional).
 */
export const MT_CLIENT_ID_PATTERN = /^[A-Za-z0-9]{1,10}_[A-Za-z0-9]{1,10}_[A-Za-z0-9]{1,10}$/;
export const MT_CLIENT_ID_MAX_LEN = 26;

export function sanitizeClientId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Already compliant? keep as-is.
  if (MT_CLIENT_ID_PATTERN.test(raw) && raw.length <= MT_CLIENT_ID_MAX_LEN) return raw;

  const alnum = raw.replace(/[^A-Za-z0-9]/g, "");
  if (!alnum) return undefined;
  // NX_<first 9 chars>_<last 8 chars>  -> max 3 + 9 + 1 + 8 = 21 chars
  const head = alnum.slice(0, 9);
  const tail = alnum.length > 9 ? alnum.slice(-8) : alnum.slice(0, 8);
  const candidate = `NX_${head}_${tail}`;
  if (!MT_CLIENT_ID_PATTERN.test(candidate) || candidate.length > MT_CLIENT_ID_MAX_LEN) {
    return undefined;
  }
  return candidate;
}


export interface MtPriceContext {
  bid?: number | null;
  ask?: number | null;
  digits?: number | null;
  /** Broker's minimum distance (in price units) for pending/SL/TP levels. */
  minDistance?: number | null;
}

export interface SanitizedPrices {
  actionType: MtAction;
  openPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  notes: string[];
}

function roundTo(value: number, digits: number): number {
  return Number(value.toFixed(Math.max(0, Math.min(8, digits))));
}

/**
 * TRADE_RETCODE_INVALID_PRICE (10015) came from three things, all fixed here:
 *   1. openPrice / stopLoss / takeProfit sent with full float precision
 *      instead of the symbol's `digits` grid.
 *   2. Limit prices on the WRONG side of the market (a buy_limit above the
 *      ask, a sell_limit below the bid) — MT5 rejects those outright. We fall
 *      back to a market order rather than dropping the trade.
 *   3. Stop-loss / take-profit on the wrong side of entry (or inside the
 *      broker's minimum stop distance) — those levels are dropped, never sent.
 */
export function sanitizeOrderPrices(
  actionType: MtAction,
  input: { limitPrice?: number | null; stopLoss?: number | null; takeProfit?: number | null },
  ctx: MtPriceContext,
): SanitizedPrices {
  const notes: string[] = [];
  const digits = Number.isFinite(Number(ctx.digits)) && Number(ctx.digits) >= 0
    ? Number(ctx.digits) : 5;
  const bid = Number(ctx.bid) > 0 ? Number(ctx.bid) : null;
  const ask = Number(ctx.ask) > 0 ? Number(ctx.ask) : null;
  const mid = bid && ask ? (bid + ask) / 2 : (bid ?? ask);
  const minDist = Number(ctx.minDistance) > 0 ? Number(ctx.minDistance) : 0;

  const isBuy = actionType === MT_ACTIONS.buy_market || actionType === MT_ACTIONS.buy_limit
    || actionType === MT_ACTIONS.buy_stop;
  let action = actionType;
  let openPrice = Number(input.limitPrice) > 0 ? roundTo(Number(input.limitPrice), digits) : undefined;

  const isPending = action !== MT_ACTIONS.buy_market && action !== MT_ACTIONS.sell_market;
  if (isPending) {
    const toMarket = (why: string) => {
      notes.push(`${why} — submitted as a market order instead`);
      action = isBuy ? MT_ACTIONS.buy_market : MT_ACTIONS.sell_market;
      openPrice = undefined;
    };
    if (!openPrice) {
      toMarket("no valid pending price");
    } else if (action === MT_ACTIONS.buy_limit && ask !== null && openPrice >= ask - minDist) {
      toMarket(`buy limit ${openPrice} is not below the ask ${ask}`);
    } else if (action === MT_ACTIONS.sell_limit && bid !== null && openPrice <= bid + minDist) {
      toMarket(`sell limit ${openPrice} is not above the bid ${bid}`);
    } else if (action === MT_ACTIONS.buy_stop && ask !== null && openPrice <= ask + minDist) {
      toMarket(`buy stop ${openPrice} is not above the ask ${ask}`);
    } else if (action === MT_ACTIONS.sell_stop && bid !== null && openPrice >= bid - minDist) {
      toMarket(`sell stop ${openPrice} is not below the bid ${bid}`);
    }
  } else {
    openPrice = undefined;
  }

  const reference = openPrice ?? (isBuy ? (ask ?? mid) : (bid ?? mid));

  const level = (raw: number | null | undefined, kind: "stopLoss" | "takeProfit") => {
    if (!(Number(raw) > 0)) return undefined;
    const v = roundTo(Number(raw), digits);
    if (!reference) return v;
    const wantAbove = kind === "takeProfit" ? isBuy : !isBuy;
    const ok = wantAbove ? v > reference + minDist : v < reference - minDist;
    if (!ok) {
      notes.push(`${kind} ${v} is on the wrong side of ${reference} — dropped`);
      return undefined;
    }
    return v;
  };

  return {
    actionType: action,
    ...(openPrice ? { openPrice } : {}),
    ...(level(input.stopLoss, "stopLoss") ? { stopLoss: level(input.stopLoss, "stopLoss") } : {}),
    ...(level(input.takeProfit, "takeProfit") ? { takeProfit: level(input.takeProfit, "takeProfit") } : {}),
    notes,
  };
}

/** Build + validate the exact JSON body MetaApi's /trade endpoint expects. */
export function buildTradeRequest(
  input: PlaceOrderInput,
  mtSymbol: string,
  ctx: MtPriceContext = {},
): Record<string, unknown> {
  const resolved = resolveTradeAction(input.side, input.orderType);
  if (!resolved) throw new Error(`Refusing to submit MT trade with undefined action for ${mtSymbol}`);
  const volume = Number(input.qty);
  if (!(volume > 0)) throw new Error(`Invalid MT volume ${input.qty} for ${mtSymbol}`);

  const priced = sanitizeOrderPrices(resolved, {
    limitPrice: input.limitPrice ?? null,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
  }, ctx);
  if (priced.notes.length) console.log(`[MT5] price sanitisation ${mtSymbol}: ${priced.notes.join("; ")}`);

  const clientId = sanitizeClientId(input.clientOrderId);
  return {
    actionType: priced.actionType,
    symbol: mtSymbol,
    volume,
    ...(priced.openPrice ? { openPrice: priced.openPrice } : {}),
    // Native broker-side protection: stopLoss/takeProfit are dedicated fields,
    // rounded to the symbol's digit grid and validated against the entry side.
    ...(priced.stopLoss ? { stopLoss: priced.stopLoss } : {}),
    ...(priced.takeProfit ? { takeProfit: priced.takeProfit } : {}),
    ...(clientId ? { clientId } : {}),
  };
}


/** Subset of MetaApi's symbol specification we care about for sizing. */
export interface MtSymbolSpec {
  volumeMin?: number;
  volumeMax?: number;
  volumeStep?: number;
  contractSize?: number;
  digits?: number;
}

export class InvalidVolumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidVolumeError";
  }
}

/** Thrown when the broker cannot fund the order — the trade is skipped, not failed. */
export class InsufficientMarginError extends Error {
  readonly required: number;
  readonly available: number;
  constructor(required: number, available: number) {
    super(`Skipped: insufficient free margin (required ${required.toFixed(2)}, available ${available.toFixed(2)}).`);
    this.name = "InsufficientMarginError";
    this.required = required;
    this.available = available;
  }
}


function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i === -1 ? 0 : Math.min(8, s.length - i - 1);
}

/**
 * Round the requested volume to the broker's volumeStep and clamp it between
 * volumeMin and volumeMax. Volumes below the minimum are raised to the minimum
 * lot (never silently submitted as-is, which is what produced
 * TRADE_RETCODE_INVALID_VOLUME 10014).
 */
export function normalizeVolume(
  requested: number,
  spec: MtSymbolSpec,
): { volume: number; adjusted: boolean; note?: string } {
  const min = Number(spec.volumeMin) > 0 ? Number(spec.volumeMin) : 0.01;
  const max = Number(spec.volumeMax) > 0 ? Number(spec.volumeMax) : Number.POSITIVE_INFINITY;
  const step = Number(spec.volumeStep) > 0 ? Number(spec.volumeStep) : min;

  if (!(Number(requested) > 0)) {
    throw new InvalidVolumeError(`Requested volume ${requested} is not a positive number`);
  }
  if (min > max) {
    throw new InvalidVolumeError(`Broker volume limits are inconsistent (min ${min} > max ${max})`);
  }

  const d = Math.max(decimalsOf(step), decimalsOf(min));
  const round = (v: number) => Number(v.toFixed(d));

  // Snap to the step grid, anchored at volumeMin.
  let volume = round(min + Math.round((requested - min) / step) * step);
  let note: string | undefined;

  if (volume < min) {
    volume = round(min);
    note = `raised to broker minimum lot ${min}`;
  }
  if (volume > max) {
    volume = round(min + Math.floor((max - min) / step) * step);
    note = `clamped to broker maximum lot ${max}`;
  }
  if (!(volume > 0)) {
    throw new InvalidVolumeError(
      `Cannot build a valid volume for this symbol (min ${min}, max ${max}, step ${step})`,
    );
  }
  const adjusted = round(requested) !== volume;
  if (adjusted && !note) note = `rounded to step ${step}`;
  return { volume, adjusted, note };
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

/** These two calls predate the shared doRequest() timeout fix and used plain
 *  fetch() directly — completely unprotected from a stalled connection.
 *  Since provisioning only runs on a cold start (when accountIdCache is
 *  empty), this was an intermittent hang: most cycles hit the cached,
 *  timeout-protected path, but any cycle that needed to (re-)provision could
 *  still hang indefinitely on these two calls specifically. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`MetaApi provisioning request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function provisionAccount(params: {
  token: string; brokerId: string; login: string; password: string;
  server: string; region: string; name: string;
}): Promise<string> {
  const platform = isMt4(params.brokerId) ? "mt4" : "mt5";
  const res = await fetchWithTimeout(`${PROVISIONING_BASE}/users/current/accounts`, {
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
  await fetchWithTimeout(`${PROVISIONING_BASE}/users/current/accounts/${parsed.id}/deploy`, {
    method: "POST", headers: { "auth-token": params.token },
  }).catch(() => undefined);
  return parsed.id;
}

// ---- Process-level caches ------------------------------------------------
// The executor creates a fresh connector per order. Without caching, each order
// re-provisions / re-lists symbols, which is what produced the repeated
// 429 TooManyRequestsError from MetaApi.
const accountIdCache = new Map<string, string>();          // credential key -> deployed accountId
const symbolMapCache = new Map<string, { at: number; map: Map<string, string> }>();
const specCache = new Map<string, { at: number; spec: MtSymbolSpec }>();  // `${accountId}|${mtSymbol}`
const SYMBOL_TTL_MS = 30 * 60 * 1000;

/**
 * MetaApi hard-caps historical-market-data requests at 5 concurrent per
 * account ("TooManyRequestsError" / HTTP 429 if exceeded). The app scans up
 * to ~90 symbols per autonomous cycle via Promise.all with zero throttling,
 * which blows straight through that cap and returns a wall of 429/504
 * errors instead of candles — this is what was actually causing entry_gate
 * failures, not stale data. A simple per-account queue fixes it: callers
 * still request candles concurrently, but at most MAX_CONCURRENT_HISTORY
 * actual HTTP requests to this endpoint are ever in flight per account at
 * once; the rest wait their turn instead of firing all at once.
 */
const MAX_CONCURRENT_HISTORY = 4; // stay safely under MetaApi's cap of 5
const historyQueues = new Map<string, { active: number; queue: Array<() => void> }>();

async function withHistoryLimit<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  let state = historyQueues.get(accountId);
  if (!state) {
    state = { active: 0, queue: [] };
    historyQueues.set(accountId, state);
  }
  if (state.active >= MAX_CONCURRENT_HISTORY) {
    await new Promise<void>(resolve => state!.queue.push(resolve));
  }
  state.active++;
  try {
    return await fn();
  } finally {
    state.active--;
    const next = state.queue.shift();
    if (next) next();
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry 429 / 5xx with exponential backoff + jitter; never retry 4xx validation. */
async function withBackoff<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const err = e as { httpStatus?: number; retryable?: boolean; message?: string };
      const status = err?.httpStatus;
      const retryable = err?.retryable === true || status === 429 || (status ?? 0) >= 500
        || /TooManyRequests/i.test(err?.message ?? "");
      if (!retryable || i === attempts - 1) throw e;
      await sleep(Math.round((500 * 2 ** i) * (1 + Math.random() * 0.3)));
    }
  }
  throw lastErr;
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
  // Stable key for this MT account across connector instances.
  const cacheKey = `${ctx.connectionId ?? ""}|${brokerId}|${state.login}|${state.server}`;
  if (!state.accountId) state.accountId = accountIdCache.get(cacheKey) ?? "";

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
    state.accountId = await withBackoff(() => provisionAccount({
      token: state.token, brokerId,
      login: state.login, password: state.password,
      server: state.server, region: state.region,
      name: `NeurlX ${brokerId.toUpperCase()} ${state.login}`,
    }));
    // Cache first so concurrent/subsequent orders never re-provision.
    accountIdCache.set(cacheKey, state.accountId);
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
    return withBackoff(() => doRequest<T>({
      ctx: logCtx, method, path, url: `${base}${path}`,
      headers: { "auth-token": state.token, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      params: body as Record<string, unknown> | undefined, signed: true,
    }));
  }

  async function marketDataReq<T>(path: string): Promise<T> {
    await ensureReady();
    return withBackoff(() => doRequest<T>({
      ctx: logCtx,
      method: "GET",
      path,
      url: `${marketDataBaseFor(state.region)}${path}`,
      headers: { "auth-token": state.token, "Content-Type": "application/json" },
      signed: true,
    }));
  }

  // ---- Broker symbol map -------------------------------------------------
  // MetaApi exposes the exact instrument names the connected broker offers
  // (they differ per broker: BTCUSD, BTCUSD.m, BTCUSDT, #BTCUSD ...). We pull
  // them once per account (cached for 30 min across connector instances) and
  // resolve every requested symbol against that list, so nothing unsupported
  // ever reaches MetaApi.
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
    symbolMapCache.set(state.accountId, { at: Date.now(), map });
    return map;
  }

  async function getSymbolMap(): Promise<Map<string, string>> {
    const cached = symbolMapCache.get(state.accountId);
    if (cached && Date.now() - cached.at < SYMBOL_TTL_MS) return cached.map;
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
    // Last resort: base+quote prefix match (covers BTCUSD.pro, CRVUSDm, ...).
    const pair = splitPair(symbol);
    if (pair) {
      const quotes = pair.quote.startsWith("USD") ? ["USD", "USDT", "USDC"] : [pair.quote];
      for (const [key, name] of map) {
        if (key.startsWith(pair.base) && quotes.some(q => key.slice(pair.base.length).startsWith(q))) {
          return name;
        }
      }
    }
    throw new UnsupportedSymbolError(symbol, label);
  }

  /** Broker's lot limits for an instrument (cached 30 min). */
  async function getSymbolSpec(mtSymbol: string): Promise<MtSymbolSpec> {
    const key = `${state.accountId}|${mtSymbol}`;
    const cached = specCache.get(key);
    if (cached && Date.now() - cached.at < SYMBOL_TTL_MS) return cached.spec;
    try {
      const spec = await req<MtSymbolSpec>(
        "GET",
        `/users/current/accounts/${state.accountId}/symbols/${encodeURIComponent(mtSymbol)}/specification`,
      );
      specCache.set(key, { at: Date.now(), spec: spec ?? {} });
      return spec ?? {};
    } catch (e) {
      console.warn("[MT5] symbol specification unavailable", mtSymbol,
        e instanceof Error ? e.message : String(e));
      return {};
    }
  }

  interface MtAccountInfo {
    broker?: string; currency?: string; balance?: number; equity?: number;
    margin?: number; freeMargin?: number; marginLevel?: number; leverage?: number;
  }

  async function accountInformation(): Promise<MtAccountInfo> {
    return req<MtAccountInfo>(
      "GET", `/users/current/accounts/${state.accountId}/accountInformation`,
    );
  }

  /** Broker-calculated margin for an order (MetaApi calculate-margin endpoint). */
  async function calcMargin(
    mtSymbol: string, actionType: string, volume: number, openPrice: number,
  ): Promise<number | null> {
    try {
      const r = await req<{ margin?: number }>(
        "POST", `/users/current/accounts/${state.accountId}/calculate-margin`,
        { symbol: mtSymbol, type: actionType, volume, openPrice },
      );
      const m = Number(r?.margin);
      return Number.isFinite(m) && m > 0 ? m : null;
    } catch (e) {
      console.warn("[MT5] margin calculation unavailable", mtSymbol,
        e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function midPrice(mtSymbol: string): Promise<number> {
    try {
      const r = await req<{ bid: number; ask: number }>(
        "GET", `/users/current/accounts/${state.accountId}/symbols/${encodeURIComponent(mtSymbol)}/current-price`,
      );
      return (Number(r.bid) + Number(r.ask)) / 2;
    } catch { return 0; }
  }


  return {
    id: brokerId, displayName: label,
    supportsRealExecution: canProvision() || isReady(),
    isMarginVenue: true,

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

    // ---- Market data (real candle history for signal generation) ---------
    // Powers the AI engine directly off this account's live broker feed,
    // instead of the synthetic/paper fallback.
    async getCandles(symbol: string, interval: string, limit: number) {
      const s = await resolveSymbol(symbol);
      const timeframe = MT_TIMEFRAME[interval] ?? interval;

      // Historical candles are served by MetaApi's dedicated market-data host,
      // not the trading/RPC host used by account information and order calls.
      // Sending this path to mt-client-api-v1 returns a route-level 404 for
      // every valid symbol, causing the committee to produce no verdicts.
      // startTime is an exclusive upper bound, so use the next bar boundary to
      // include the current/latest broker bar.
      const timeframeMs = MT_TIMEFRAME_MS[timeframe] ?? 15 * 60_000;
      const nextBoundary = Math.ceil((Date.now() + 1) / timeframeMs) * timeframeMs;
      const qs = new URLSearchParams({
        startTime: new Date(nextBoundary).toISOString(),
        limit: String(Math.min(limit, 1000)),
      }).toString();
      const r = await withHistoryLimit(state.accountId, () => marketDataReq<Array<{
        time: string; open: number; high: number; low: number; close: number;
        tickVolume?: number; volume?: number;
      }>>(
        `/users/current/accounts/${state.accountId}/historical-market-data/symbols/${encodeURIComponent(s)}/timeframes/${timeframe}/candles?${qs}`,
      ));
      const candles = (r ?? [])
        .map(c => ({
          ts: new Date(c.time).getTime(),
          open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
          volume: Number(c.volume ?? c.tickVolume ?? 0),
        }))
        .filter(c => Number.isFinite(c.ts) && Number.isFinite(c.close))
        .sort((a, b) => a.ts - b.ts)
        .slice(-limit);

      // Freshness telemetry: prints the timestamp of the newest bar the broker
      // actually returned, so a stale feed is visible directly in the logs.
      const last = candles[candles.length - 1];
      if (last) {
        const ageSec = Math.round((Date.now() - last.ts) / 1000);
        console.log(
          `[mt5:candles] ${symbol}->${s} ${timeframe} n=${candles.length} ` +
          `last=${new Date(last.ts).toISOString()} age=${ageSec}s close=${last.close}`,
        );
      } else {
        console.warn(`[mt5:candles] ${symbol}->${s} ${timeframe} returned NO candles`);
      }
      return candles;
    },


    /** The broker's actual tradable instrument list, translated to NeurlX
     *  "BASE-QUOTE" symbol form so the scanner can research pairs beyond the
     *  fixed hardcoded universe (forex, metals, indices — not just crypto). */
    async listSymbols(): Promise<string[]> {
      const map = await getSymbolMap();
      const out = new Set<string>();
      for (const mtName of new Set(map.values())) {
        out.add(brokerSymbolToNeurlx(mtName));
      }
      return [...out];
    },

    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const started = Date.now();
      // Throws UnsupportedSymbolError for instruments the broker doesn't list,
      // so the caller skips the trade instead of submitting a bad request.
      const mtSymbol = await resolveSymbol(input.symbol);

      // Broker lot limits decide the final volume — submitting an unrounded or
      // sub-minimum size is what produced TRADE_RETCODE_INVALID_VOLUME (10014).
      const spec = await getSymbolSpec(mtSymbol);
      const requestedVolume = Number(input.qty);

      // ---- Dynamic sizing + margin pre-check --------------------------------
      // Size from equity/risk/stop distance, then cap by usable free margin so
      // we never submit a volume the account cannot fund.
      const info = await accountInformation().catch(() => ({} as MtAccountInfo));
      const equity = Number(info.equity ?? info.balance ?? 0);
      const freeMargin = Number(info.freeMargin ?? 0);
      const probeAction = resolveTradeAction(input.side, input.orderType);
      const refPrice = Number(input.limitPrice) > 0 ? Number(input.limitPrice) : await midPrice(mtSymbol);
      const marginPerLot = refPrice > 0 ? await calcMargin(mtSymbol, probeAction, 1, refPrice) : null;

      let sized = normalizeVolume(requestedVolume, spec);
      const sizingNotes: string[] = sized.note ? [sized.note] : [];

      if (marginPerLot && freeMargin > 0) {
        const { computePositionSize } = await import("@/lib/execution/sizing");
        const plan = computePositionSize({
          equity, freeMargin,
          riskPct: 0, // risk-based target comes from the caller's qty
          entryPrice: refPrice,
          stopLoss: input.stopPrice ?? null,
          spec: {
            volumeMin: Number(spec.volumeMin ?? 0.01),
            volumeMax: Number(spec.volumeMax ?? 100),
            volumeStep: Number(spec.volumeStep ?? 0.01),
            contractSize: Number(spec.contractSize ?? 1),
            marginPerLot,
          },
        });
        // Cap the requested size by what margin allows.
        const usable = freeMargin * 0.8;
        const maxByMargin = usable / marginPerLot;
        if (sized.volume > maxByMargin) {
          const capped = normalizeVolume(Math.max(maxByMargin, 0.0000001), spec);
          sizingNotes.push(`capped by free margin to ${capped.volume} lots`);
          sized = capped;
        }
        const required = marginPerLot * sized.volume;
        if (required > usable) {
          throw new InsufficientMarginError(required, usable);
        }
        sizingNotes.push(...plan.notes.filter(n => n.startsWith("capped")));
      }

      // Live quote + digit grid: without these, openPrice/SL/TP went to the
      // broker unrounded and sometimes on the wrong side of the market, which
      // is exactly what TRADE_RETCODE_INVALID_PRICE (10015) reports.
      const quote = await req<{ bid: number; ask: number }>(
        "GET", `/users/current/accounts/${state.accountId}/symbols/${encodeURIComponent(mtSymbol)}/current-price`,
      ).catch(() => null);
      const priceCtx = {
        bid: quote?.bid ?? null,
        ask: quote?.ask ?? null,
        digits: spec.digits ?? null,
        minDistance: null,
      };

      // Normalizes any committee wording (buy/sell/long/short, market/limit/stop)
      // into a valid MetaApi action and validates before submitting.
      const body = buildTradeRequest({ ...input, qty: sized.volume }, mtSymbol, priceCtx);
      const actionType = body.actionType as string;
      const requiredMargin = marginPerLot ? Number((marginPerLot * sized.volume).toFixed(2)) : null;

      // Exact request body + broker limits logged before the call.
      console.log("[MT5] trade request", JSON.stringify({
        accountId: state.accountId, requestedSymbol: input.symbol, mtSymbol,
        requestedVolume, finalVolume: sized.volume,
        volumeNote: sizingNotes.join("; ") || null,
        margin: { perLot: marginPerLot, required: requiredMargin, freeMargin },
        brokerLimits: {
          volumeMin: spec.volumeMin ?? null, volumeMax: spec.volumeMax ?? null,
          volumeStep: spec.volumeStep ?? null, contractSize: spec.contractSize ?? null,
        },
        body,
      }));


      // MetaApi's REST /trade endpoint takes the trade object at the top level.
      type TradeResponse = { orderId: string; positionId?: string; numericCode: number; stringCode: string; message?: string };
      const submit = (b: Record<string, unknown>) => req<TradeResponse>(
        "POST", `/users/current/accounts/${state.accountId}/trade`, b,
      );
      let r = await submit(body);
      const isDone = (x: TradeResponse) => x.stringCode === "TRADE_RETCODE_DONE" || x.numericCode === 10009;
      // Prices can move between the quote and the fill. A single 10015 retry as
      // a clean market order (no stale openPrice) recovers that race instead of
      // burning the candidate and tripping the consecutive-failure breaker.
      if (!isDone(r) && (r.numericCode === 10015 || /INVALID_PRICE/i.test(r.stringCode ?? ""))) {
        const isBuy = actionType === MT_ACTIONS.buy_market || actionType === MT_ACTIONS.buy_limit
          || actionType === MT_ACTIONS.buy_stop;
        const retry = { ...body, actionType: isBuy ? MT_ACTIONS.buy_market : MT_ACTIONS.sell_market };
        delete (retry as Record<string, unknown>).openPrice;
        console.log(`[MT5] 10015 on ${mtSymbol} — retrying as market`, JSON.stringify(retry));
        r = await submit(retry);
      }
      const success = isDone(r);
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
        raw: {
          mtSymbol, actionType, requestedSymbol: input.symbol,
          requestedVolume, finalVolume: sized.volume,
          volumeNote: sizingNotes.join("; ") || null,
          margin: { perLot: marginPerLot, required: requiredMargin, freeMargin },
          metaApiOrderId: r.orderId ?? null,
          brokerPositionTicket: r.positionId ?? null,
          brokerLimits: {
            volumeMin: spec.volumeMin ?? null, volumeMax: spec.volumeMax ?? null,
            volumeStep: spec.volumeStep ?? null, contractSize: spec.contractSize ?? null,
          },
          request: body, response: r,
        },
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

    /** Closes (fully, or partially if `volume` is given) an existing broker
     *  position by its MetaApi/MT5 ticket. Used by the app's profit-protection
     *  engine and manual close actions — this is the one place a real open
     *  position actually gets closed on the broker; everything else (the
     *  app's own `positions` table) is just NeurlX's bookkeeping of this. */
    async closeLivePosition(brokerPositionId: string, volume?: number) {
      const body = volume
        ? { actionType: "POSITION_PARTIAL", positionId: brokerPositionId, volume }
        : { actionType: "POSITION_CLOSE_ID", positionId: brokerPositionId };
      const r = await req<{ numericCode: number; stringCode: string; price?: number; message?: string }>(
        "POST", `/users/current/accounts/${state.accountId}/trade`, body,
      );
      const success = r.stringCode === "TRADE_RETCODE_DONE" || r.numericCode === 10009;
      if (!success) {
        throw new Error(
          `MT close rejected for position ${brokerPositionId}: ${r.stringCode ?? "unknown"} (${r.numericCode ?? "?"})${r.message ? " — " + r.message : ""}`,
        );
      }
      return { fillPrice: r.price ?? null };
    },

    async getPositions(): Promise<ConnectorPosition[]> {
      try {
        const r = await req<Array<{ id: string; symbol: string; volume: number; type: string; openPrice: number }>>(
          "GET", `/users/current/accounts/${state.accountId}/positions`,
        );
        return (r ?? []).map(p => ({
          symbol: p.symbol,
          qty: p.type === "POSITION_TYPE_SELL" ? -p.volume : p.volume,
          avgEntry: p.openPrice,
          brokerPositionId: String(p.id),
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

    // ---- Live desk -------------------------------------------------------
    async getAccountSummary(): Promise<AccountSummary | null> {
      try {
        const r = await accountInformation();
        const equity = Number(r.equity ?? r.balance ?? 0);
        const used = Number(r.margin ?? 0);
        return {
          currency: r.currency ?? "USD",
          balance: Number(r.balance ?? 0),
          equity,
          freeMargin: Number(r.freeMargin ?? 0),
          usedMargin: used,
          marginLevel: r.marginLevel != null ? Number(r.marginLevel)
            : used > 0 ? (equity / used) * 100 : null,
          leverage: r.leverage ?? null,
        };
      } catch { return null; }
    },

    async getRichPositions(): Promise<RichPosition[]> {
      try {
        const r = await req<Array<{
          id: string; symbol: string; type: string; volume: number; openPrice: number;
          currentPrice?: number; profit?: number; swap?: number; commission?: number;
          stopLoss?: number; takeProfit?: number; time: string; margin?: number;
        }>>("GET", `/users/current/accounts/${state.accountId}/positions`);
        return (r ?? []).map(p => ({
          ticket: String(p.id),
          symbol: p.symbol,
          side: p.type === "POSITION_TYPE_SELL" ? "short" as const : "long" as const,
          volume: Number(p.volume ?? 0),
          openPrice: Number(p.openPrice ?? 0),
          currentPrice: p.currentPrice != null ? Number(p.currentPrice) : null,
          profit: Number(p.profit ?? 0),
          swap: Number(p.swap ?? 0),
          commission: Number(p.commission ?? 0),
          usedMargin: p.margin != null ? Number(p.margin) : null,
          stopLoss: p.stopLoss != null ? Number(p.stopLoss) : null,
          takeProfit: p.takeProfit != null ? Number(p.takeProfit) : null,
          openedAt: p.time,
          raw: p,
        }));
      } catch { return []; }
    },

    async getClosedDeals(sinceMs = Date.now() - 90 * 24 * 3600 * 1000): Promise<ClosedDeal[]> {
      try {
        const end = new Date().toISOString();
        const start = new Date(sinceMs).toISOString();
        const deals = await req<Array<{
          id: string; positionId?: string; symbol?: string; type: string; entryType?: string;
          volume?: number; price?: number; profit?: number; commission?: number; swap?: number;
          time: string; comment?: string;
        }>>("GET", `/users/current/accounts/${state.accountId}/history-deals/time/${start}/${end}`);

        // Pair DEAL_ENTRY_IN with DEAL_ENTRY_OUT on the same broker position.
        const opens = new Map<string, { price: number; time: string; type: string }>();
        const out: ClosedDeal[] = [];
        for (const d of deals ?? []) {
          if (!d.symbol) continue;
          const pos = String(d.positionId ?? d.id);
          if (d.entryType === "DEAL_ENTRY_IN") {
            opens.set(pos, { price: Number(d.price ?? 0), time: d.time, type: d.type });
            continue;
          }
          if (d.entryType && d.entryType !== "DEAL_ENTRY_OUT" && d.entryType !== "DEAL_ENTRY_OUT_BY") continue;
          const open = opens.get(pos);
          const gross = Number(d.profit ?? 0);
          const commission = Number(d.commission ?? 0);
          const swap = Number(d.swap ?? 0);
          out.push({
            ticket: String(d.id),
            positionTicket: d.positionId ? String(d.positionId) : null,
            symbol: d.symbol,
            // Closing deal side is the inverse of the position direction.
            side: d.type === "DEAL_TYPE_SELL" ? "long" : "short",
            volume: Number(d.volume ?? 0),
            entryPrice: open ? open.price : null,
            exitPrice: Number(d.price ?? 0),
            grossProfit: gross,
            commission,
            swap,
            netProfit: Number((gross + commission + swap).toFixed(2)),
            openedAt: open?.time ?? null,
            closedAt: d.time,
            comment: d.comment ?? null,
          });
        }
        return out.sort((a, b) => +new Date(b.closedAt) - +new Date(a.closedAt));
      } catch { return []; }
    },

    async estimateMargin(symbol, side, volume, price): Promise<MarginEstimate | null> {
      try {
        const mtSymbol = await resolveSymbol(symbol);
        const action = resolveTradeAction(side, "market");
        const p = Number(price) > 0 ? Number(price) : await midPrice(mtSymbol);
        const margin = await calcMargin(mtSymbol, action, volume, p);
        const info = await accountInformation();
        const freeMargin = Number(info.freeMargin ?? 0);
        if (margin == null) return null;
        return { margin, freeMargin, sufficient: margin <= freeMargin * 0.8 };
      } catch { return null; }
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
