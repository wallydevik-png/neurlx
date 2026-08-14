// AI Committee — multi-analyst consensus signal ranker.
// Runs the indicator engine per symbol, then re-scores each result through
// three "analyst" lenses (Trend, Mean-Reversion, Momentum). Each analyst
// casts a vote (buy/sell/wait) with a confidence. Consensus is majority
// direction + weighted-average confidence, then pairs are ranked so
// autopilot always trades the best available opportunity across the
// entire watchlist rather than whatever came first.
import { fetchCandlesWithSource } from "@/lib/marketdata/service.server";
import { analyzeCandles, type AiSignal, type Direction } from "@/lib/trading/aiEngine.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { trendBias } from "@/lib/analysis/institutional";
import { ema, macd, rsi } from "@/lib/analysis/indicators";

/** Resample a 15m close series into 4h buckets (16 bars each) so we can read
 *  a higher-timeframe bias without an extra broker request per symbol. */
function resampleCloses(closes: number[], factor: number): number[] {
  const out: number[] = [];
  for (let i = closes.length - 1; i >= 0; i -= factor) out.unshift(closes[i]!);
  return out;
}

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
  /** Cheap higher-timeframe bias derived by resampling the 15m series into
   *  4h buckets. Used to drop candidates that the strict entry gate would
   *  reject on "Higher-timeframe alignment" before they consume a slot. */
  htfBias: "bullish" | "bearish" | "neutral";
  /** Exact 15m confirmation using the same MACD/RSI/EMA rule as the
   * authoritative institutional entry gate. Keeping this on the verdict lets
   * autopilot discard stale committee votes before they consume an HTF slot. */
  entryMomentumConfirmed: boolean;
  entryMomentumDetail: string;
}

function entryMomentum(
  closes: number[],
  side: Direction,
): { confirmed: boolean; detail: string } {
  if (side === "wait") return { confirmed: false, detail: "committee direction is WAIT" };
  const m = macd(closes, 12, 26, 9);
  const r = rsi(closes, 14);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  // Recalibrated: 2 of 3 momentum conditions instead of all 3, with wider RSI
  // bands. Requiring MACD + RSI + EMA to agree simultaneously on a 15m bar is
  // a coincidence filter, not a quality filter — it rejected setups where the
  // trend was clean but the histogram happened to be crossing zero.
  const hist = m?.histogram ?? 0;
  const rv = r ?? 50;
  const conds = side === "buy"
    ? [hist >= 0, rv > 40 && rv < 82, (e20 ?? 0) >= (e50 ?? 0)]
    : [hist <= 0, rv < 60 && rv > 18, (e20 ?? 0) <= (e50 ?? 0)];
  const confirmed = !!m && conds.filter(Boolean).length >= 2;
  return {
    confirmed,
    detail: `MACD ${m?.histogram.toFixed(8) ?? "n/a"}, RSI ${r?.toFixed(1) ?? "n/a"}, EMA20/50 ${e20 != null && e50 != null ? (e20 >= e50 ? "bullish" : "bearish") : "n/a"}`,
  };
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
  // Confidence measures conviction, not direction. Using the signed score made
  // bearish votes look like low confidence, blocking sell-side autopilot trades.
  const confidence = Math.min(0.99, Math.max(0.05, 0.5 + Math.abs(score) * 0.75));
  // Lowered direction floor from 0.15 → 0.08 so ranging markets still surface
  // the strongest available bias instead of everyone voting "wait".
  let direction: Direction = "wait";
  if (score > 0.05) direction = "buy";
  else if (score < -0.05) direction = "sell";
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
  userId?: string | null,
): Promise<CommitteeVerdict[]> {
  // MetaApi rate-limits large bursts. Scan with a small worker pool instead of
  // firing the entire broker universe at once; one failed symbol remains
  // isolated and cannot starve every otherwise valid committee candidate.
  const results: Array<CommitteeVerdict | null> = new Array(symbols.length).fill(null);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < symbols.length) {
      const index = nextIndex++;
      const symbol = symbols[index];
      if (!symbol) continue;
      try {
        const { candles, source, isSynthetic } = await fetchCandlesWithSource(supabase, symbol, "15m", 200, userId);
        if (!candles || candles.length < 60) continue;
        const base = analyzeCandles(symbol, candles, source, isSynthetic);
        const votes = voteFor(base);
        const c = consensus(votes);
        // Ranking: consensus confidence × agreement × base regime multiplier
        // (base.confidence already includes regime adjustment).
        const score = c.confidence * c.agreement * (0.5 + base.confidence / 2);
        const closes = candles.map(k => k.close);
        const momentum = entryMomentum(closes, c.direction);
        // 200 x 15m bars only resample into ~12 4h buckets, which is below the
        // sample trendBias needs. Report "neutral" instead of silently falling
        // back to the 15m bias — the real 1D/4H/1H check runs in htfFilter.
        const resampled = resampleCloses(closes, 16);
        const htfBias = resampled.length >= 20 ? trendBias(resampled) : "neutral";

        results[index] = {
          symbol, base, votes,
          consensusDirection: c.direction,
          consensusConfidence: c.confidence,
          agreement: c.agreement,
          score,
          htfBias,
          entryMomentumConfirmed: momentum.confirmed,
          entryMomentumDetail: momentum.detail,
        } as CommitteeVerdict;
      } catch (e) {
        console.warn(
          `[committee] skipped ${symbol}: live candles unavailable:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, symbols.length) }, () => worker()));
  return results
    .filter((r): r is CommitteeVerdict => r !== null)
    .sort((a, b) => b.score - a.score);
}
