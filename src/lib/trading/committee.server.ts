// AI Committee — multi-analyst consensus signal ranker.
// Runs the indicator engine per symbol, then re-scores each result through
// three "analyst" lenses (Trend, Mean-Reversion, Momentum). Each analyst
// casts a vote (buy/sell/wait) with a confidence. Consensus is majority
// direction + weighted-average confidence, then pairs are ranked so
// autopilot always trades the best available opportunity across the
// entire watchlist rather than whatever came first.
import { fetchCandles } from "@/lib/marketdata/service.server";
import { analyzeCandles, type AiSignal, type Direction } from "@/lib/trading/aiEngine.server";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AnalystVote {
  analyst: "Trend" | "MeanReversion" | "Momentum";
  direction: Direction;
  confidence: number; // 0..1
  rationale: string;
}

export interface CommitteeVerdict {
  symbol: string;
  base: AiSignal;                  // full analysis for the trade
  votes: AnalystVote[];
  consensusDirection: Direction;
  consensusConfidence: number;     // 0..1
  agreement: number;               // 0..1 — % of analysts agreeing with consensus
  score: number;                   // ranking score
}

// Re-weight a base analysis through an analyst's perspective by looking at
// which contributions dominate. Each analyst boosts different indicators.
function reweight(base: AiSignal, weights: Record<string, number>): AnalystVote {
  let score = 0;
  const drivers: string[] = [];
  for (const c of base.contributions) {
    const w = weights[c.indicator] ?? 0;
    if (c.signal === "bullish") score += w;
    else if (c.signal === "bearish") score -= w;
    if (w > 0.15 && c.weight !== 0) drivers.push(c.indicator);
  }
  // Boosted confidence curve so consensus can realistically clear a 0.65 bar
  // on modest-but-directional setups (previously capped ~0.75 for perfect scores).
  const confidence = Math.min(0.99, Math.max(0.05, 0.5 + score * 0.75));
  // Lowered direction floor from 0.15 → 0.08 so ranging markets still surface
  // the strongest available bias instead of everyone voting "wait".
  let direction: Direction = "wait";
  if (score > 0.08) direction = "buy";
  else if (score < -0.08) direction = "sell";
  return {
    analyst: "Trend",
    direction,
    confidence,
    rationale: drivers.length ? `Weighted on ${drivers.join(", ")}` : "No dominant signals",
  };
}

function voteFor(base: AiSignal): AnalystVote[] {
  return [
    { ...reweight(base, { "EMA 20/50": 0.35, "MACD": 0.3, "Volume": 0.15, "RSI(14)": 0.1, "Bollinger": 0.1 }), analyst: "Trend" },
    { ...reweight(base, { "RSI(14)": 0.4, "Bollinger": 0.35, "MACD": 0.1, "EMA 20/50": 0.05, "Volume": 0.1 }), analyst: "MeanReversion" },
    { ...reweight(base, { "Volume": 0.35, "MACD": 0.25, "Bollinger": 0.15, "EMA 20/50": 0.15, "RSI(14)": 0.1 }), analyst: "Momentum" },
  ];
}

function consensus(votes: AnalystVote[]): { direction: Direction; confidence: number; agreement: number } {
  const tally: Record<Direction, number> = { buy: 0, sell: 0, wait: 0 };
  for (const v of votes) tally[v.direction]++;
  const direction = (Object.keys(tally) as Direction[]).reduce((a, b) => tally[a] >= tally[b] ? a : b);
  const agree = votes.filter(v => v.direction === direction);
  const confidence = agree.length
    ? agree.reduce((s, v) => s + v.confidence, 0) / agree.length
    : 0;
  return { direction, confidence, agreement: agree.length / votes.length };
}

export async function runCommittee(
  supabase: SupabaseClient | null,
  symbols: string[],
): Promise<CommitteeVerdict[]> {
  const results = await Promise.all(symbols.map(async (symbol) => {
    try {
      const candles = await fetchCandles(supabase, symbol, "15m", 200);
      if (!candles || candles.length < 60) return null;
      const base = analyzeCandles(symbol, candles);
      const votes = voteFor(base);
      const c = consensus(votes);
      // Ranking: consensus confidence × agreement × base regime multiplier
      // (base.confidence already includes regime adjustment).
      const score = c.confidence * c.agreement * (0.5 + base.confidence / 2);
      return {
        symbol, base, votes,
        consensusDirection: c.direction,
        consensusConfidence: c.confidence,
        agreement: c.agreement,
        score,
      } as CommitteeVerdict;
    } catch {
      return null;
    }
  }));
  return results
    .filter((r): r is CommitteeVerdict => r !== null)
    .sort((a, b) => b.score - a.score);
}
