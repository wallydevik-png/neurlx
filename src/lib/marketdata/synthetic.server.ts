// Synthetic OHLCV generator — deterministic per (symbol, interval, bucket).
// Produces realistic-looking candles with trend + volatility clustering so
// technical indicators return meaningful values. Server-only.
import type { Candle, Interval, MarketDataProvider } from "./types";
import { BASE_PRICES } from "./symbols";

const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000, "5m": 5*60_000, "15m": 15*60_000,
  "1h": 60*60_000, "4h": 4*60*60_000, "1d": 24*60*60_000,
};

function seed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(s: number): () => number {
  let x = s || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1_000_000) / 1_000_000; };
}

function generate(symbol: string, interval: Interval, limit: number, endTs: number): Candle[] {
  const base = BASE_PRICES[symbol] ?? 100;
  const step = INTERVAL_MS[interval];
  const bucketEnd = Math.floor(endTs / step) * step;
  const startBucket = bucketEnd - step * (limit - 1);
  const rng = rand(seed(`${symbol}:${interval}`));
  // Warm-up: walk from a couple hundred bars back so trends look continuous.
  const warmup = 200;
  let price = base;
  let vol = base * 0.015;
  const out: Candle[] = [];
  const totalBars = limit + warmup;
  for (let i = 0; i < totalBars; i++) {
    // Volatility clustering (GARCH-lite)
    vol = vol * 0.94 + (base * 0.015) * 0.06 + (rng() - 0.5) * base * 0.002;
    if (vol < base * 0.005) vol = base * 0.005;
    const drift = Math.sin((i + seed(symbol) % 100) / 40) * base * 0.001;
    const change = (rng() - 0.5) * vol + drift;
    const open = price;
    const close = Math.max(0.0001, price + change);
    const high = Math.max(open, close) + rng() * vol * 0.5;
    const low  = Math.min(open, close) - rng() * vol * 0.5;
    const volume = Math.round((rng() * 500 + 200) * (1 + Math.abs(change) / vol));
    price = close;
    if (i >= warmup) {
      const ts = startBucket + (i - warmup) * step;
      out.push({ ts, open: +open.toFixed(6), high: +high.toFixed(6), low: +low.toFixed(6), close: +close.toFixed(6), volume });
    }
  }
  return out;
}

export function createSyntheticProvider(): MarketDataProvider {
  return {
    id: "synthetic",
    displayName: "Synthetic feed (paper)",
    supports: (s) => s in BASE_PRICES,
    async getCandles(symbol, interval, limit) {
      return generate(symbol, interval, limit, Date.now());
    },
    async getLastPrice(symbol) {
      const c = generate(symbol, "1m", 1, Date.now());
      return c[0].close;
    },
  };
}
