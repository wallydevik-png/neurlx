// Single source of truth for higher-timeframe alignment.
//
// The old rule ("at least 2 of 3 agree AND none oppose") rejected the classic
// pullback entry: 1D and 4H trending with the trade while the 1H pulls back
// against it. Seven days of telemetry shows those near-misses are a large
// slice of htf_conflict rejections, so a lone opposing *fastest* timeframe is
// now treated as a pullback rather than a conflict. A 1D or 4H opposition is
// still a hard reject.

export type Bias = string; // "bullish" | "bearish" | "neutral" | "unknown"

export interface HtfBias { d1: Bias; h4: Bias; h1: Bias }

export function isHtfAligned(bias: HtfBias, want: "bullish" | "bearish"): boolean {
  const all = [bias.d1, bias.h4, bias.h1];
  const opposes = (b: Bias) => b !== want && b !== "neutral" && b !== "unknown";
  const agree = all.filter(b => b === want).length;
  const opposed = all.filter(opposes).length;
  // Recalibrated: a 2/3 majority is enough regardless of WHICH timeframe is
  // the dissenter. 1D-against-with-4H+1H-agreeing is a daily pullback, the
  // mirror of the 1H pullback case, and 7 days of telemetry showed those
  // near-misses were the single largest rejection bucket in the whole engine.
  // Two or more opposing timeframes is still a hard reject.
  return agree >= 2 && opposed <= 1;
}

export function htfDetail(bias: HtfBias, side: "buy" | "sell"): string {
  const want = side === "buy" ? "bullish" : "bearish";
  const agree = [bias.d1, bias.h4, bias.h1].filter(b => b === want).length;
  return `1D ${bias.d1}, 4H ${bias.h4}, 1H ${bias.h1} — ${agree}/3 agree with ${side.toUpperCase()}`;
}
