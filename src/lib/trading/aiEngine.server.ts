// Explainable AI signal engine. Replaces the earlier random mock with a
// deterministic indicator-driven decision, so every signal carries a full
// breakdown of the contributing factors. Ready for a future ML model:
// swap out the score aggregation while keeping the same output contract.
import { fetchCandles } from "@/lib/marketdata/service.server";
import { atr, bollinger, detectTrend, ema, macd, rsi, sma, volumeStats } from "@/lib/analysis/indicators";
import { classifyRegime, type MarketRegime } from "@/lib/analysis/regime";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Direction = "buy" | "sell" | "wait";
export type RiskLevel = "low" | "medium" | "high";
export type TimeHorizon = "scalp" | "intraday" | "swing";

export interface Contribution {
  indicator: string;
  signal: "bullish" | "bearish" | "neutral";
  weight: number;         // -1..+1 contribution
  detail: string;
}

export interface AiSignal {
  symbol: string;
  direction: Direction;
  side: "buy" | "sell";      // for storage; when direction=wait we still store 'buy' as placeholder
  confidence: number;         // 0..1
  confidenceScore: number;    // 0..100
  timeHorizon: TimeHorizon;
  riskLevel: RiskLevel;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  riskReward: number;
  reasoning: string;
  regime: MarketRegime;
  regimeLabel: string;
  indicators: Record<string, number | string | null>;
  contributions: Contribution[];
  riskFactors: string[];
}

const HORIZON_BY_INTERVAL = { "5m": "scalp", "15m": "intraday", "1h": "swing" } as const;
const TARGET_NOTIONAL = 500;

export async function analyzeSymbol(supabase: SupabaseClient | null, symbol: string): Promise<AiSignal> {
  const candles = await fetchCandles(supabase, symbol, "15m", 200);
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1];

  const rsiV = rsi(closes, 14);
  const macdV = macd(closes, 12, 26, 9);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const sma200 = sma(closes, Math.min(200, closes.length));
  const bb = bollinger(closes, 20, 2);
  const atrV = atr(candles, 14);
  const vol = volumeStats(candles, 20);
  const trend = detectTrend(closes);
  const regime = classifyRegime(candles);

  const contributions: Contribution[] = [];
  let score = 0; // -1..+1 aggregate

  if (rsiV !== null) {
    if (rsiV < 30) { contributions.push({ indicator: "RSI(14)", signal: "bullish", weight: 0.25, detail: `Oversold at ${rsiV.toFixed(1)}` }); score += 0.25; }
    else if (rsiV > 70) { contributions.push({ indicator: "RSI(14)", signal: "bearish", weight: -0.25, detail: `Overbought at ${rsiV.toFixed(1)}` }); score -= 0.25; }
    else contributions.push({ indicator: "RSI(14)", signal: "neutral", weight: 0, detail: `${rsiV.toFixed(1)} — mid-range` });
  }

  if (macdV) {
    if (macdV.histogram > 0 && macdV.macd > macdV.signal) {
      contributions.push({ indicator: "MACD", signal: "bullish", weight: 0.2, detail: `Histogram +${macdV.histogram.toFixed(4)}, above signal line` });
      score += 0.2;
    } else if (macdV.histogram < 0 && macdV.macd < macdV.signal) {
      contributions.push({ indicator: "MACD", signal: "bearish", weight: -0.2, detail: `Histogram ${macdV.histogram.toFixed(4)}, below signal line` });
      score -= 0.2;
    } else contributions.push({ indicator: "MACD", signal: "neutral", weight: 0, detail: "Crossover ambiguous" });
  }

  if (ema20 !== null && ema50 !== null) {
    const spread = (ema20 - ema50) / ema50;
    if (spread > 0.005) { contributions.push({ indicator: "EMA 20/50", signal: "bullish", weight: 0.2, detail: `Fast EMA ${(spread*100).toFixed(2)}% above slow — trend up` }); score += 0.2; }
    else if (spread < -0.005) { contributions.push({ indicator: "EMA 20/50", signal: "bearish", weight: -0.2, detail: `Fast EMA ${(spread*100).toFixed(2)}% below slow — trend down` }); score -= 0.2; }
    else contributions.push({ indicator: "EMA 20/50", signal: "neutral", weight: 0, detail: "EMAs entwined" });
  }

  if (bb && last) {
    if (bb.percentB < 0.15) { contributions.push({ indicator: "Bollinger", signal: "bullish", weight: 0.15, detail: `Price near lower band (%B=${(bb.percentB*100).toFixed(0)}%)` }); score += 0.15; }
    else if (bb.percentB > 0.85) { contributions.push({ indicator: "Bollinger", signal: "bearish", weight: -0.15, detail: `Price near upper band (%B=${(bb.percentB*100).toFixed(0)}%)` }); score -= 0.15; }
    else contributions.push({ indicator: "Bollinger", signal: "neutral", weight: 0, detail: `%B ${(bb.percentB*100).toFixed(0)}%` });
  }

  if (vol) {
    if (vol.ratio > 1.5) { contributions.push({ indicator: "Volume", signal: score >= 0 ? "bullish" : "bearish", weight: Math.sign(score) * 0.1, detail: `Volume ${vol.ratio.toFixed(2)}× 20-bar average — conviction` }); score += Math.sign(score) * 0.1; }
    else contributions.push({ indicator: "Volume", signal: "neutral", weight: 0, detail: `${vol.ratio.toFixed(2)}× average` });
  }

  // Apply regime multiplier
  const rawScore = score;
  const adjScore = Math.max(-1, Math.min(1, score * regime.confidenceMultiplier));
  const confidence = Math.min(0.99, Math.max(0.05, 0.5 + adjScore / 2));

  const riskFactors: string[] = [];
  if (regime.regime === "extreme_risk") riskFactors.push("Extreme volatility — most strategies underperform.");
  if (regime.regime === "high_volatility") riskFactors.push("Elevated ATR — wider stops required.");
  if (vol && vol.ratio < 0.5) riskFactors.push("Volume below average — liquidity/execution risk.");
  if (bb && (bb.percentB > 0.95 || bb.percentB < 0.05)) riskFactors.push("Price at band extreme — mean reversion possible.");
  if (Math.abs(rawScore) < 0.15) riskFactors.push("Weak directional edge — signal borderline.");

  let direction: Direction = "wait";
  if (adjScore > 0.2 && regime.regime !== "extreme_risk") direction = "buy";
  else if (adjScore < -0.2 && regime.regime !== "extreme_risk") direction = "sell";

  // Risk framing
  const atrPct = atrV && last ? atrV / last : 0.02;
  const slDist = Math.max(0.008, Math.min(0.05, atrPct * 1.5));
  const rr = 2.0;
  const side: "buy" | "sell" = direction === "sell" ? "sell" : "buy";
  const dir = side === "buy" ? 1 : -1;
  const entry = +last.toFixed(6);
  const stopLoss = +(entry * (1 - dir * slDist)).toFixed(6);
  const takeProfit = +(entry * (1 + dir * slDist * rr)).toFixed(6);
  const qty = +(TARGET_NOTIONAL / entry).toFixed(6);

  const riskLevel: RiskLevel = regime.regime === "extreme_risk" ? "high"
    : regime.regime === "high_volatility" ? "high"
    : Math.abs(adjScore) > 0.5 ? "low" : "medium";

  const timeHorizon: TimeHorizon = HORIZON_BY_INTERVAL["15m"];

  const dominant = contributions.filter(c => c.weight !== 0).sort((a,b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 3);
  const dominantStr = dominant.map(d => `${d.indicator} (${d.signal})`).join(", ");
  const reasoning = direction === "wait"
    ? `No high-conviction setup on ${symbol}. Regime: ${regime.label}. ${dominantStr || "Indicators inconclusive."} No trade recommended.`
    : `${direction.toUpperCase()} ${symbol} — ${regime.label} regime. Primary drivers: ${dominantStr}. Setup risk framed at ${(slDist*100).toFixed(1)}% stop with ${rr}:1 reward. Past performance does not guarantee future results.`;

  return {
    symbol, direction, side,
    confidence, confidenceScore: Math.round(confidence * 100),
    timeHorizon, riskLevel,
    entry, stopLoss, takeProfit, qty, riskReward: rr,
    reasoning,
    regime: regime.regime,
    regimeLabel: regime.label,
    indicators: {
      rsi: rsiV !== null ? +rsiV.toFixed(2) : null,
      macd: macdV ? +macdV.macd.toFixed(4) : null,
      macd_signal: macdV ? +macdV.signal.toFixed(4) : null,
      macd_hist: macdV ? +macdV.histogram.toFixed(4) : null,
      ema20: ema20 !== null ? +ema20.toFixed(4) : null,
      ema50: ema50 !== null ? +ema50.toFixed(4) : null,
      sma200: sma200 !== null ? +sma200.toFixed(4) : null,
      bb_percent_b: bb ? +(bb.percentB).toFixed(3) : null,
      bb_width: bb ? +(bb.width).toFixed(4) : null,
      atr: atrV !== null ? +atrV.toFixed(4) : null,
      atr_pct: +(atrPct*100).toFixed(2),
      volume_ratio: vol ? +vol.ratio.toFixed(2) : null,
      trend,
      last_price: last,
    },
    contributions,
    riskFactors,
  };
}

export async function scanMarket(supabase: SupabaseClient | null, symbols: string[]): Promise<AiSignal[]> {
  const results = await Promise.all(symbols.map(s => analyzeSymbol(supabase, s).catch(() => null)));
  return results.filter((s): s is AiSignal => s !== null)
    .sort((a, b) => b.confidenceScore - a.confidenceScore);
}
