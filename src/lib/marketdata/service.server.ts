// Market data facade + on-write caching to public.market_candles.
// Adding a real provider = implement MarketDataProvider and register here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candle, Interval, MarketDataProvider } from "./types";
import { createSyntheticProvider, SUPPORTED_SYMBOLS } from "./synthetic.server";

const providers: MarketDataProvider[] = [createSyntheticProvider()];

export function listSupportedSymbols(): string[] {
  return SUPPORTED_SYMBOLS;
}

function providerFor(symbol: string): MarketDataProvider {
  const p = providers.find(p => p.supports(symbol));
  if (!p) throw new Error(`No market-data provider for ${symbol}`);
  return p;
}

export async function fetchCandles(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: Interval,
  limit = 200,
): Promise<Candle[]> {
  const provider = providerFor(symbol);
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
}

export async function fetchLastPrice(symbol: string): Promise<number> {
  return providerFor(symbol).getLastPrice(symbol);
}
