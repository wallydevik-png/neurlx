// Deterministic mock AI signal generator. Real model plugs in here later.
import { createPaperConnector } from "@/lib/connectors/paper.server";

const REASONS = [
  "Momentum breakout above 20-period high with rising volume; regime = trending.",
  "RSI(14) oversold reversal at key support; MACD histogram flipping positive.",
  "Mean-reversion setup near lower Bollinger band with declining volatility.",
  "Higher-timeframe trend alignment; pullback to 50 EMA on decreasing sell pressure.",
  "Breakout retest with volume expansion; risk-defined at recent swing low.",
];

export interface GeneratedSignal {
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  qty: number;
  confidence: number;
  reasoning: string;
  riskReward: number;
}

export async function generateSignal(allowedAssets: string[]): Promise<GeneratedSignal> {
  const pool = allowedAssets.length ? allowedAssets : ["BTC-USD", "ETH-USD", "SOL-USD"];
  const symbol = pool[Math.floor(Math.random() * pool.length)];
  const paper = createPaperConnector();
  const quote = await paper.getQuote(symbol);
  const side: "buy" | "sell" = Math.random() > 0.35 ? "buy" : "sell";
  const entry = side === "buy" ? quote.ask : quote.bid;
  const slPct = 0.02 + Math.random() * 0.02;     // 2–4%
  const tpPct = slPct * (1.5 + Math.random() * 1.5); // R:R 1.5–3x
  const stopLoss = +(entry * (1 - (side === "buy" ? 1 : -1) * slPct)).toFixed(4);
  const takeProfit = +(entry * (1 + (side === "buy" ? 1 : -1) * tpPct)).toFixed(4);
  const confidence = +(0.55 + Math.random() * 0.4).toFixed(3);
  const qty = +(500 / entry).toFixed(6);
  const riskReward = +(tpPct / slPct).toFixed(2);
  return {
    symbol, side, entry, stopLoss, takeProfit, qty, confidence,
    reasoning: REASONS[Math.floor(Math.random() * REASONS.length)],
    riskReward,
  };
}
