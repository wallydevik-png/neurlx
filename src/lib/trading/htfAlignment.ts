// Single source of truth for higher-timeframe alignment.
//
// The gate rule itself is unchanged: at least 2 of the 3 higher timeframes
// must agree with the proposed direction, and at most 1 may actively
// contradict it. What changed is the *representation*: a timeframe whose bias
// could not be computed ("unknown") or whose data could not be fetched
// ("unavailable") is no longer flattened into the same "N/3 agree" number as a
// genuine contradiction. Those are materially different situations and the
// telemetry now says which one occurred.

export type HtfState = "bullish" | "bearish" | "neutral" | "unknown" | "unavailable";
export type Bias = string; // tolerated for legacy callers

export interface HtfBias { d1: Bias; h4: Bias; h1: Bias }

export interface HtfTally {
  /** timeframes confirming the proposed direction */
  agree: number;
  /** timeframes actively pointing the other way */
  contradict: number;
  /** timeframes explicitly flat */
  neutral: number;
  /** bias could not be computed (insufficient candles) */
  unknown: number;
  /** candles could not be fetched at all */
  unavailable: number;
}

export type HtfClassification =
  | "aligned"
  | "full_contradiction"
  | "partial_contradiction"
  | "near_miss"
  /** read successfully, but the higher timeframes simply don't confirm */
  | "no_confirmation"
  /** some timeframes could not be read — infrastructure, not a market verdict */
  | "insufficient_data"
  | "unavailable";

function normalize(state: Bias): HtfState {
  return state === "bullish" || state === "bearish" || state === "neutral"
    || state === "unknown" || state === "unavailable"
    ? state
    : "unknown";
}

export function tallyHtf(bias: HtfBias, want: "bullish" | "bearish"): HtfTally {
  const against = want === "bullish" ? "bearish" : "bullish";
  const tally: HtfTally = { agree: 0, contradict: 0, neutral: 0, unknown: 0, unavailable: 0 };
  for (const raw of [bias.d1, bias.h4, bias.h1]) {
    const s = normalize(raw);
    if (s === want) tally.agree++;
    else if (s === against) tally.contradict++;
    else if (s === "neutral") tally.neutral++;
    else if (s === "unavailable") tally.unavailable++;
    else tally.unknown++;
  }
  return tally;
}

/** Gate rule (unchanged): >= 2 agreeing timeframes and <= 1 contradicting one.
 *  Unknown / unavailable timeframes are never counted as contradictions, but
 *  they also cannot substitute for confirmation — the gate fails closed. */
export function isHtfAligned(bias: HtfBias, want: "bullish" | "bearish"): boolean {
  const t = tallyHtf(bias, want);
  return t.agree >= 2 && t.contradict <= 1;
}

/** Why a candidate failed (or passed) the HTF gate, without pretending that
 *  missing data is a contradiction. */
export function classifyHtf(bias: HtfBias, want: "bullish" | "bearish"): HtfClassification {
  const t = tallyHtf(bias, want);
  if (t.agree >= 2 && t.contradict <= 1) return "aligned";
  if (t.unavailable === 3) return "unavailable";
  if (t.contradict === 0) {
    // Nothing is actually fighting the trade. Distinguish "we could not read
    // the higher timeframes" (an infrastructure failure) from "we read them
    // and they simply do not confirm" (a legitimate trading rejection).
    if (t.unavailable > 0 || t.unknown > 0) return "insufficient_data";
    return "no_confirmation";
  }

  if (t.contradict >= 2) return "full_contradiction";
  // Exactly one contradicting timeframe.
  return t.agree >= 1 ? "near_miss" : "partial_contradiction";
}

/** Structured, unambiguous telemetry string. */
export function htfTelemetry(bias: HtfBias, side: "buy" | "sell"): string {
  const want = side === "buy" ? "bullish" : "bearish";
  const t = tallyHtf(bias, want);
  return `direction=${side.toUpperCase()} agree=${t.agree} contradict=${t.contradict}`
    + ` neutral=${t.neutral} unknown=${t.unknown} unavailable=${t.unavailable}`
    + ` [1D ${normalize(bias.d1)}, 4H ${normalize(bias.h4)}, 1H ${normalize(bias.h1)}]`;
}

export function htfDetail(bias: HtfBias, side: "buy" | "sell"): string {
  return htfTelemetry(bias, side);
}
