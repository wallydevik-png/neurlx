// Pure technical indicator functions. Input: array of close prices (oldest→newest)
// unless otherwise noted. All return the latest value(s); designed to be safe
// against short series (return null instead of throwing).

export interface Candle {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

export function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(e);
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out.push(e); }
  return out;
}

export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

export interface MacdOut { macd: number; signal: number; histogram: number; }
export function macd(values: number[], fast = 12, slow = 26, signalP = 9): MacdOut | null {
  if (values.length < slow + signalP) return null;
  const fastE = emaSeries(values, fast);
  const slowE = emaSeries(values, slow);
  // align tails
  const len = Math.min(fastE.length, slowE.length);
  const macdLine: number[] = [];
  for (let i = 0; i < len; i++) macdLine.push(fastE[fastE.length - len + i] - slowE[slowE.length - len + i]);
  const sig = ema(macdLine, signalP);
  if (sig === null) return null;
  const macdV = macdLine[macdLine.length - 1];
  return { macd: macdV, signal: sig, histogram: macdV - sig };
}

export interface BbOut { upper: number; middle: number; lower: number; width: number; percentB: number; }
export function bollinger(values: number[], period = 20, mult = 2): BbOut | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd, lower = mean - mult * sd;
  const last = values[values.length - 1];
  return { upper, middle: mean, lower, width: (upper - lower) / mean, percentB: (last - lower) / (upper - lower) };
}

export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return sma(trs, period);
}

export interface VolumeStats { avg: number; last: number; ratio: number; }
export function volumeStats(candles: Candle[], period = 20): VolumeStats | null {
  if (candles.length < period) return null;
  const vols = candles.slice(-period).map(c => c.volume);
  const avg = vols.reduce((a, b) => a + b, 0) / period;
  const last = candles[candles.length - 1].volume;
  return { avg, last, ratio: avg > 0 ? last / avg : 1 };
}

export type Trend = "up" | "down" | "sideways";
export function detectTrend(closes: number[]): Trend {
  const e20 = ema(closes, 20), e50 = ema(closes, 50);
  if (e20 === null || e50 === null) return "sideways";
  const diff = (e20 - e50) / e50;
  if (diff > 0.005) return "up";
  if (diff < -0.005) return "down";
  return "sideways";
}
