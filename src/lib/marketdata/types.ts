// Modular market-data provider interface. New providers (Binance, Coinbase,
// Alpaca, etc.) implement this shape and register in ./registry.ts.
import type { Candle } from "@/lib/analysis/indicators";

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export interface MarketDataProvider {
  id: string;
  displayName: string;
  supports(symbol: string): boolean;
  getCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]>;
  getLastPrice(symbol: string): Promise<number>;
}

export type { Candle };
