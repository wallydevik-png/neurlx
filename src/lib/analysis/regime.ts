// Classify current market regime from indicator snapshot.
import type { Candle } from "./indicators";
import { atr, bollinger, detectTrend, ema } from "./indicators";

export type MarketRegime = "trending_up" | "trending_down" | "ranging" | "high_volatility" | "extreme_risk";

export interface RegimeReport {
  regime: MarketRegime;
  label: string;
  description: string;
  volatilityPct: number;   // ATR / price
  trend: "up" | "down" | "sideways";
  bbWidth: number;
  confidenceMultiplier: number; // 0.5..1.1 — applied to signal confidence
}

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

  let regime: MarketRegime;
  let confidenceMultiplier = 1;
  let description = "";

  if (volPct > 0.06) {
    regime = "extreme_risk";
    confidenceMultiplier = 0.5;
    description = "Extreme volatility detected. Position sizing should be minimal; many strategies fail in this regime.";
  } else if (volPct > 0.035) {
    regime = "high_volatility";
    confidenceMultiplier = 0.75;
    description = "Elevated volatility. Widen stops and reduce size; mean-reversion signals may whipsaw.";
  } else if (trend === "up" && e20 > e50) {
    regime = "trending_up";
    confidenceMultiplier = 1.1;
    description = "Bullish trend regime. Trend-following longs have edge; counter-trend shorts are risky.";
  } else if (trend === "down" && e20 < e50) {
    regime = "trending_down";
    confidenceMultiplier = 1.1;
    description = "Bearish trend regime. Trend-following shorts have edge; counter-trend longs are risky.";
  } else {
    regime = "ranging";
    confidenceMultiplier = 0.9;
    description = "Range-bound conditions. Mean-reversion setups near band extremes; avoid breakout chasing.";
  }

  const label: Record<MarketRegime, string> = {
    trending_up: "Trending (bullish)",
    trending_down: "Trending (bearish)",
    ranging: "Ranging",
    high_volatility: "High volatility",
    extreme_risk: "Extreme risk",
  };

  return { regime, label: label[regime], description, volatilityPct: volPct, trend, bbWidth, confidenceMultiplier };
}
