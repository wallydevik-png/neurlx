// Market data facade + on-write caching to public.market_candles.
// Adding a real provider = implement MarketDataProvider and register here.
//
// Provider order/behavior:
//   1. If a userId is supplied and that user has a connected MetaTrader
//      (or MT-routed broker) account, its LIVE candles are used — this
//      covers crypto, forex, indices, and stocks alike, not just crypto.
//   2. Otherwise (or if the live fetch fails), we fall back to the
//      synthetic generator — but every such fallback is logged and
//      surfaced via `source`/`isSynthetic` on the result, never silent.
//
// Bybit has been intentionally removed as a provider: it geo-blocks some
// regions entirely, which previously caused every request to fail across
// all its fallback hosts and silently land on synthetic data with no
// indication anywhere in the app.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candle, Interval, MarketDataProvider, MarketDataRequestOptions } from "./types";
import { createSyntheticProvider } from "./synthetic.server";
import { listSupportedSymbols as listStaticSymbols } from "./symbols";
import {
  resolveUserMt5Connector,
  createMt5MarketDataProvider,
  listMt5TradableSymbols,
} from "./mt5Provider.server";

const staticProviders: MarketDataProvider[] = [
  createSyntheticProvider(),
];

export function listSupportedSymbols(): string[] {
  return listStaticSymbols();
}

/** The tradable universe to scan: the user's real broker symbol list when
 *  they have a MetaTrader-family account connected, otherwise the static
 *  fallback list. This is what lets the scanner "research" pairs beyond
 *  the fixed crypto-only set once a broker is linked. */
export async function listTradableSymbols(
  supabase: SupabaseClient | null,
  userId?: string | null,
): Promise<string[]> {
  const live = await listMt5TradableSymbols(supabase, userId);
  return live ?? listStaticSymbols();
}

export interface CandleFetchResult {
  candles: Candle[];
  source: string;
  isSynthetic: boolean;
}

async function resolveProvidersFor(
  supabase: SupabaseClient | null,
  userId: string | null | undefined,
  symbol: string,
): Promise<MarketDataProvider[]> {
  const ordered: MarketDataProvider[] = [];
  let hasLiveBroker = false;
  if (userId) {
    const connector = await resolveUserMt5Connector(supabase, userId);
    const mt5Provider = connector ? createMt5MarketDataProvider(connector) : null;
    if (mt5Provider) {
      ordered.push(mt5Provider);
      hasLiveBroker = true;
    }
  }
  // Never fabricate candles for an account configured for live MT execution.
  // A broker-data failure must stop signal generation rather than produce a
  // plausible-looking signal that can reach a real-money order path.
  if (!hasLiveBroker) ordered.push(...staticProviders.filter(p => p.supports(symbol)));
  if (!ordered.length) throw new Error(`No market-data provider for ${symbol}`);
  return ordered;
}

/** Core candle fetch. `userId` is optional for backward compatibility with
 *  callers that don't yet have per-user routing wired up (they'll just get
 *  the synthetic fallback, as before) — but every signal-generation path
 *  should pass it through so it gets live broker data. */
export async function fetchCandles(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: Interval,
  limit = 200,
  userId?: string | null,
  opts?: MarketDataRequestOptions,
): Promise<Candle[]> {
  const result = await fetchCandlesWithSource(supabase, symbol, interval, limit, userId, opts);
  return result.candles;
}

/** Same as fetchCandles, but also reports which provider actually served the
 *  data so callers (the AI engine, in particular) can stamp signals with
 *  provenance instead of silently treating synthetic data as real. */
// ---- Per-cycle request coalescing + short-TTL cache -----------------------
// The same symbol/timeframe is requested by the committee, the HTF filter, the
// momentum check and the entry gate within one cycle. Each of those used to be
// an independent provider request, which is what pushed MetaApi past its
// 5-concurrent-history-request account cap. Identical requests now share ONE
// in-flight provider call, and a completed result is reused for a fraction of
// the bar interval. Failures are never cached, and each symbol/timeframe has
// its own entry, so one symbol's timeout cannot affect another's.
const CANDLE_TTL_MS: Record<string, number> = {
  "1m": 20_000, "5m": 45_000, "15m": 120_000,
  "1h": 300_000, "4h": 900_000, "1d": 1_800_000,
};

interface CacheEntry {
  at: number;
  ttl: number;
  value?: CandleFetchResult;
  inFlight?: Promise<CandleFetchResult>;
  /** Cancellation shared by every consumer of one in-flight provider call. */
  controller?: AbortController;
  consumers?: number;
  cancelled?: number;
}
const candleCache = new Map<string, CacheEntry>();

/** Test/telemetry hook. */
export function resetCandleCache() { candleCache.clear(); }

/**
 * Joins an already in-flight request. Two properties matter:
 *  - one consumer giving up (cycle budget, stage deadline) must NOT cancel the
 *    shared provider call while another consumer still needs the data;
 *  - the shared call must still be cancellable once *every* consumer is gone,
 *    so an abandoned cycle stops occupying a provider slot.
 */
function join(entry: CacheEntry, signal?: AbortSignal): Promise<CandleFetchResult> {
  const shared = entry.inFlight!;
  entry.consumers = (entry.consumers ?? 0) + 1;
  if (!signal) return shared;
  if (signal.aborted) {
    entry.cancelled = (entry.cancelled ?? 0) + 1;
    if (entry.cancelled >= (entry.consumers ?? 1)) entry.controller?.abort();
    return Promise.reject(new Error("market-data request cancelled"));
  }
  return new Promise<CandleFetchResult>((resolve, reject) => {
    const onAbort = () => {
      entry.cancelled = (entry.cancelled ?? 0) + 1;
      // Only the LAST interested consumer may cancel the underlying request.
      if (entry.cancelled >= (entry.consumers ?? 1)) entry.controller?.abort();
      reject(new Error("market-data request cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(
      v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export async function fetchCandlesWithSource(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: Interval,
  limit = 200,
  userId?: string | null,
  opts?: MarketDataRequestOptions,
): Promise<CandleFetchResult> {
  const key = `${userId ?? "anon"}|${symbol}|${interval}|${limit}`;
  const now = Date.now();
  const hit = candleCache.get(key);
  if (hit) {
    if (hit.value && now - hit.at < hit.ttl) return hit.value;
    if (hit.inFlight) return join(hit, opts?.signal);
  }
  const ttl = CANDLE_TTL_MS[interval] ?? 60_000;
  // The shared call gets its OWN signal, aborted only when every consumer has
  // walked away — never by whichever consumer happened to time out first.
  const controller = new AbortController();
  const entry: CacheEntry = { at: now, ttl, controller, consumers: 0, cancelled: 0 };
  const sharedOpts: MarketDataRequestOptions = { ...opts, signal: controller.signal };
  const inFlight = fetchCandlesUncached(supabase, symbol, interval, limit, userId, sharedOpts)
    .then(value => {
      // Only real broker data is worth reusing. Failures are never cached.
      if (!value.isSynthetic) candleCache.set(key, { at: Date.now(), ttl, value });
      else candleCache.delete(key);
      return value;
    })
    .catch(e => { candleCache.delete(key); throw e; });
  entry.inFlight = inFlight;
  candleCache.set(key, entry);
  return join(entry, opts?.signal);
}


async function fetchCandlesUncached(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: Interval,
  limit = 200,
  userId?: string | null,
  opts?: MarketDataRequestOptions,
): Promise<CandleFetchResult> {
  let lastError: unknown = null;
  for (const provider of await resolveProvidersFor(supabase, userId, symbol)) {
    try {
      const candles = await provider.getCandles(symbol, interval, limit, opts);
      if (!candles.length) continue;
      const isSynthetic = provider.id === "synthetic";
      if (isSynthetic) {
        console.warn(`[marketdata] FALLBACK TO SYNTHETIC DATA for ${symbol} (${interval}) — ` +
          `no live provider available${userId ? ` for user ${userId}` : ""}. Signal will be flagged.`);
      }
      // Best-effort persistence — never block signal generation on cache write.
      if (supabase && candles.length) {
        const latest = candles[candles.length - 1];
        supabase.from("market_candles").upsert({
          symbol, interval, ts: new Date(latest.ts).toISOString(),
          open: latest.open, high: latest.high, low: latest.low,
          close: latest.close, volume: latest.volume, source: provider.id,
        }, { onConflict: "symbol,interval,ts,source" }).then(() => {}, () => {});
      }
      return { candles, source: provider.id, isSynthetic };
    } catch (e) {
      lastError = e;
      console.warn(
        `[marketdata] ${provider.id} failed for ${symbol} (${interval}):`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`No market-data provider succeeded for ${symbol}`);
}

export async function fetchLastPrice(symbol: string, userId?: string | null, supabase?: SupabaseClient | null): Promise<number> {
  let lastError: unknown = null;
  for (const provider of await resolveProvidersFor(supabase ?? null, userId, symbol)) {
    try {
      return await provider.getLastPrice(symbol);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`No market-data provider succeeded for ${symbol}`);
}

export async function fallbackLastPrice(symbol: string): Promise<number> {
  const fallback = createSyntheticProvider();
  if (!fallback.supports(symbol)) {
    throw new Error(`No fallback market-data provider for ${symbol}`);
  }
  console.warn(`[marketdata] FALLBACK TO SYNTHETIC DATA for ${symbol} via fallbackLastPrice().`);
  return fallback.getLastPrice(symbol);
}
