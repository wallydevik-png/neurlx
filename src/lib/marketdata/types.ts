// Modular market-data provider interface. New providers (Binance, Coinbase,
// Alpaca, etc.) implement this shape and register in ./registry.ts.
import type { Candle } from "@/lib/analysis/indicators";

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** Cancellation/budget controls threaded from the autonomous cycle down to the
 *  actual provider fetch, so an expired cycle stops consuming provider slots
 *  instead of leaving requests running into the next tick. */
export interface MarketDataRequestOptions {
  signal?: AbortSignal;
  /** Max time this caller is willing to wait for a free provider slot. */
  queueWaitMs?: number;
  /** Max time the provider itself may take before the request is aborted. */
  providerTimeoutMs?: number;
}

export interface MarketDataProvider {
  id: string;
  displayName: string;
  supports(symbol: string): boolean;
  getCandles(
    symbol: string, interval: Interval, limit: number,
    opts?: MarketDataRequestOptions,
  ): Promise<Candle[]>;
  getLastPrice(symbol: string): Promise<number>;
}

export type { Candle };
