// Market regime classification — institutional version.
// Adds ADX-based trend strength, a low-volatility (dead market) class and an
// explicit `tradable` flag so the entry gate can reject untradeable regimes.
import type { Candle } from "./indicators";
import { atr, bollinger, detectTrend, ema } from "./indicators";
import { adx } from "./institutional";

export type MarketRegime =
  | "trending_up"
  | "trending_down"
  | "ranging"
  | "low_volatility"
  | "high_volatility"
  | "extreme_risk";

export interface RegimeReport {
  regime: MarketRegime;
  label: string;
  description: string;
  volatilityPct: number;   // ATR / price
  trend: "up" | "down" | "sideways";
  bbWidth: number;
  adx: number | null;
  trendStrength: "none" | "weak" | "moderate" | "strong";
  /** false → the autonomous engine must not open new trades in this regime. */
  tradable: boolean;
  /** Strategies that historically work in this regime. */
  preferredStrategies: string[];
  confidenceMultiplier: number; // 0.4..1.15 — applied to signal confidence
}

const LABELS: Record<MarketRegime, string> = {
  trending_up: "Trending (bullish)",
  trending_down: "Trending (bearish)",
  ranging: "Ranging",
  low_volatility: "Low volatility",
  high_volatility: "High volatility",
  extreme_risk: "Extreme risk",
};

export function classifyRegime(candles: Candle[]): RegimeReport {
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1] ?? 1;
  const atrV = atr(candles, 14) ?? 0;
  const bb = bollinger(closes, 20, 2);
  const trend = detectTrend(closes);
  const e20 = ema(closes, 20) ?? last;
  const e50 = ema(closes, 50) ?? last;
  const volPct = last > 0 ? atrV / last : 0;
  const bbWidth = bb?.width ?? 0;
  const adxOut = adx(candles, 14);
  const adxV = adxOut?.adx ?? null;

  const trendStrength: RegimeReport["trendStrength"] =
    adxV === null ? "none" : adxV >= 40 ? "strong" : adxV >= 25 ? "moderate" : adxV >= 20 ? "weak" : "none";

  let regime: MarketRegime;
  let confidenceMultiplier = 1;
  let description = "";
  let tradable = true;
  let preferredStrategies: string[] = [];

  if (volPct > 0.06) {
    regime = "extreme_risk";
    confidenceMultiplier = 0.4;
    tradable = false;
    description = "Extreme volatility. Capital preservation takes priority — no new positions.";
    preferredStrategies = [];
  } else if (volPct > 0.035) {
    regime = "high_volatility";
    confidenceMultiplier = 0.7;
    description = "Elevated volatility. Wider ATR stops, reduced size, breakout bias only.";
    preferredStrategies = ["breakout", "volatility_expansion"];
  } else if (volPct < 0.003 || (bbWidth > 0 && bbWidth < 0.01)) {
    regime = "low_volatility";
    confidenceMultiplier = 0.6;
    tradable = false;
    description = "Compressed, near-dead market. Edge is not worth the spread — stand aside.";
    preferredStrategies = [];
  } else if (trend === "up" && e20 > e50 && (adxV === null || adxV >= 20)) {
    regime = "trending_up";
    confidenceMultiplier = adxV !== null && adxV >= 25 ? 1.15 : 1.05;
    description = "Bullish trend regime. Trend-following and pullback longs have edge.";
    preferredStrategies = ["trend_following", "pullback_continuation", "breakout"];
  } else if (trend === "down" && e20 < e50 && (adxV === null || adxV >= 20)) {
    regime = "trending_down";
    confidenceMultiplier = adxV !== null && adxV >= 25 ? 1.15 : 1.05;
    description = "Bearish trend regime. Trend-following and pullback shorts have edge.";
    preferredStrategies = ["trend_following", "pullback_continuation", "breakout"];
  } else {
    regime = "ranging";
    confidenceMultiplier = 0.9;
    description = "Range-bound conditions. Mean reversion at band extremes; no breakout chasing.";
    preferredStrategies = ["mean_reversion", "range_fade"];
  }

  return {
    regime, label: LABELS[regime], description,
    volatilityPct: volPct, trend, bbWidth,
    adx: adxV === null ? null : +adxV.toFixed(1),
    trendStrength, tradable, preferredStrategies, confidenceMultiplier,
  };
}
