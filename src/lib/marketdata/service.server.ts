// Market data facade + on-write caching to public.market_candles.
// Adding a real provider = implement MarketDataProvider and register here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candle, Interval, MarketDataProvider } from "./types";
import { createSyntheticProvider } from "./synthetic.server";
import { createBybitMarketDataProvider } from "./bybit.server";
import { listSupportedSymbols as listSymbols } from "./symbols";

// Order matters — first provider that .supports() the symbol wins.
// Bybit covers all "-USD" crypto pairs with live public data; the synthetic
// provider is the fallback for stocks and anything Bybit does not list.
const providers: MarketDataProvider[] = [
  createBybitMarketDataProvider(),
  createSyntheticProvider(),
];

export function listSupportedSymbols(): string[] {
  return listSymbols();
}

function providersFor(symbol: string): MarketDataProvider[] {
  const supported = providers.filter(p => p.supports(symbol));
  if (!supported.length) throw new Error(`No market-data provider for ${symbol}`);
  return supported;
}

export async function fetchCandles(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: Interval,
  limit = 200,
): Promise<Candle[]> {
  let lastError: unknown = null;
  for (const provider of providersFor(symbol)) {
    try {
      const candles = await provider.getCandles(symbol, interval, limit);
      // Best-effort persistence — never block signal generation on cache write.
      if (supabase && candles.length) {
        // Only write the most recent bar per call to keep the table bounded.
        const latest = candles[candles.length - 1];
        supabase.from("market_candles").upsert({
          symbol, interval, ts: new Date(latest.ts).toISOString(),
          open: latest.open, high: latest.high, low: latest.low,
          close: latest.close, volume: latest.volume, source: provider.id,
        }, { onConflict: "symbol,interval,ts,source" }).then(() => {}, () => {});
      }
      return candles;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`No market-data provider succeeded for ${symbol}`);
}

export async function fetchLastPrice(symbol: string): Promise<number> {
  let lastError: unknown = null;
  for (const provider of providersFor(symbol)) {
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
  return fallback.getLastPrice(symbol);
}
