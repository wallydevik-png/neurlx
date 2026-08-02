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
import type { Candle, Interval, MarketDataProvider } from "./types";
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
  if (userId) {
    const connector = await resolveUserMt5Connector(supabase, userId);
    const mt5Provider = connector ? createMt5MarketDataProvider(connector) : null;
    if (mt5Provider) ordered.push(mt5Provider);
  }
  ordered.push(...staticProviders.filter(p => p.supports(symbol)));
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
): Promise<Candle[]> {
  const result = await fetchCandlesWithSource(supabase, symbol, interval, limit, userId);
  return result.candles;
}

/** Same as fetchCandles, but also reports which provider actually served the
 *  data so callers (the AI engine, in particular) can stamp signals with
 *  provenance instead of silently treating synthetic data as real. */
export async function fetchCandlesWithSource(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: Interval,
  limit = 200,
  userId?: string | null,
): Promise<CandleFetchResult> {
  let lastError: unknown = null;
  for (const provider of await resolveProvidersFor(supabase, userId, symbol)) {
    try {
      const candles = await provider.getCandles(symbol, interval, limit);
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
