// Execution Intelligence — pure entry-quality mathematics.
//
// Everything in this module is deterministic and side-effect free so it can be
// unit tested and replayed over historical candles during backtests. The
// server orchestrator (executionIntel.server.ts) does the I/O.
//
// Responsibilities:
//   * Entry Timing AI (0-100 score from pullback, VWAP/EMA distance, structure,
//     liquidity, volatility, session and momentum)
//   * Multi-timeframe confirmation (1D → 5M)
//   * Order-flow reading: liquidity pools, sweeps, BOS / CHoCH
//   * Volatility engine (ATR + spread state)
//   * Session AI (Asian / London / New York / overlaps)
//   * Smart order type selection (market / limit / stop)
//   * Dynamic SL (1.5–3 ATR) and TP (1:2 → 1:5 RR)
//   * Trailing + partial-close plan (BE at +1R, trail from +2R, 25% at 1R/2R/3R)
//   * Position quality grading (A+ → F)
//   * Learning: weight re-optimisation + Welch t-test significance

import type { Candle } from "@/lib/analysis/indicators";
import { atr, ema, macd, rsi } from "@/lib/analysis/indicators";
import { adx, lastSwingHigh, lastSwingLow } from "@/lib/analysis/institutional";

export type Side = "buy" | "sell";

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------
export function vwap(candles: Candle[], lookback = 60): number | null {
  const c = candles.slice(-lookback);
  if (!c.length) return null;
  let pv = 0, vol = 0;
  for (const k of c) {
    const typical = (k.high + k.low + k.close) / 3;
    const v = k.volume > 0 ? k.volume : 1;
    pv += typical * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

// ---------------------------------------------------------------------------
// Market structure — BOS (break of structure) vs CHoCH (change of character)
// ---------------------------------------------------------------------------
export type StructureEvent = "bos_up" | "bos_down" | "choch_up" | "choch_down" | "none";

export function marketStructure(candles: Candle[], lookback = 80): StructureEvent {
  const c = candles.slice(-lookback);
  if (c.length < 20) return "none";
  const prior = c.slice(0, -3);
  const high = lastSwingHigh(prior, prior.length);
  const low = lastSwingLow(prior, prior.length);
  const recent = c.slice(-3);
  const closes = c.map(k => k.close);
  const e20 = ema(closes, Math.min(20, closes.length - 1));
  const brokeUp = high !== null && recent.some(k => k.close > high);
  const brokeDown = low !== null && recent.some(k => k.close < low);
  if (brokeUp && !brokeDown) return e20 !== null && closes[closes.length - 1] > e20 ? "bos_up" : "choch_up";
  if (brokeDown && !brokeUp) return e20 !== null && closes[closes.length - 1] < e20 ? "bos_down" : "choch_down";
  return "none";
}

// ---------------------------------------------------------------------------
// Liquidity pools — clusters of equal highs / equal lows
// ---------------------------------------------------------------------------
export interface LiquidityPool { price: number; touches: number; side: "above" | "below"; }

export function liquidityPools(candles: Candle[], lookback = 120, tolerance = 0.0015): LiquidityPool[] {
  const c = candles.slice(-lookback);
  if (c.length < 10) return [];
  const last = c[c.length - 1].close;
  const pools: LiquidityPool[] = [];
  const cluster = (values: number[], side: "above" | "below") => {
    const sorted = [...values].sort((a, b) => a - b);
    let i = 0;
    while (i < sorted.length) {
      let j = i, sum = 0;
      while (j < sorted.length && Math.abs(sorted[j] - sorted[i]) / sorted[i] <= tolerance) {
        sum += sorted[j]; j++;
      }
      const touches = j - i;
      if (touches >= 2) pools.push({ price: +(sum / touches).toFixed(8), touches, side });
      i = j;
    }
  };
  cluster(c.filter(k => k.high > last).map(k => k.high), "above");
  cluster(c.filter(k => k.low < last).map(k => k.low), "below");
  return pools.sort((a, b) => b.touches - a.touches).slice(0, 6);
}

/** A sweep = wick through an opposite-side pool that closed back inside. */
export function liquiditySweep(candles: Candle[], side: Side, bars = 5): boolean {
  const c = candles.slice(-Math.max(bars + 20, 25));
  if (c.length < 12) return false;
  const window = c.slice(-bars);
  const prior = c.slice(0, -bars);
  if (!prior.length) return false;
  if (side === "buy") {
    const priorLow = Math.min(...prior.map(k => k.low));
    return window.some(k => k.low < priorLow && k.close > priorLow);
  }
  const priorHigh = Math.max(...prior.map(k => k.high));
  return window.some(k => k.high > priorHigh && k.close < priorHigh);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export type TradingSession = "asian" | "london" | "london_ny_overlap" | "new_york" | "off_hours";

export function classifySession(now: Date = new Date()): TradingSession {
  const h = now.getUTCHours();
  if (h >= 13 && h < 16) return "london_ny_overlap";
  if (h >= 7 && h < 13) return "london";
  if (h >= 16 && h < 21) return "new_york";
  if (h >= 0 && h < 7) return "asian";
  return "off_hours";
}

/** Baseline session quality, blended with the user's measured session stats. */
export const BASE_SESSION_SCORE: Record<TradingSession, number> = {
  london_ny_overlap: 95,
  london: 85,
  new_york: 80,
  asian: 55,
  off_hours: 35,
};

export interface SessionStat { session: TradingSession; trades: number; winRate: number; expectancy: number; }

export function sessionScore(session: TradingSession, stats: SessionStat[] = []): number {
  const base = BASE_SESSION_SCORE[session];
  const s = stats.find(x => x.session === session);
  if (!s || s.trades < 10) return base;
  const measured = Math.max(0, Math.min(100, s.winRate * 100 + (s.expectancy > 0 ? 15 : -25)));
  // Blend: measured evidence gains weight as sample size grows (cap at 40 trades).
  const w = Math.min(1, s.trades / 40) * 0.6;
  return +((1 - w) * base + w * measured).toFixed(1);
}

// ---------------------------------------------------------------------------
// Volatility engine
// ---------------------------------------------------------------------------
export type VolatilityState = "dead" | "low" | "normal" | "elevated" | "extreme";

export interface VolatilityRead {
  state: VolatilityState;
  atr: number;
  atrPct: number;
  ratio: number;          // current ATR vs its own 50-bar average
  spreadBps: number | null;
  spreadOk: boolean;
  tradable: boolean;
  score: number;          // 0..100
}

export function volatilityEngine(
  candles: Candle[], spreadBps: number | null, maxSpreadBps = 30,
): VolatilityRead | null {
  const a = atr(candles, 14);
  const price = candles[candles.length - 1]?.close;
  if (!a || !price || a <= 0) return null;
  // Average ATR over the previous 50 bars for a relative read.
  const window = candles.slice(-64);
  const hist: number[] = [];
  for (let i = 20; i < window.length; i++) {
    const v = atr(window.slice(0, i + 1), 14);
    if (v) hist.push(v);
  }
  const avg = hist.length ? hist.reduce((s, x) => s + x, 0) / hist.length : a;
  const ratio = avg > 0 ? a / avg : 1;
  const atrPct = a / price;

  let state: VolatilityState = "normal";
  if (ratio < 0.55 || atrPct < 0.0008) state = "dead";
  else if (ratio < 0.8) state = "low";
  else if (ratio > 2.2 || atrPct > 0.06) state = "extreme";
  else if (ratio > 1.4) state = "elevated";

  const spreadOk = spreadBps == null || spreadBps <= maxSpreadBps;
  const spreadPenalty = spreadBps == null ? 0 : Math.min(40, (spreadBps / maxSpreadBps) * 40);
  const stateScore = state === "normal" ? 100 : state === "elevated" ? 80
    : state === "low" ? 65 : state === "dead" ? 25 : 15;
  return {
    state, atr: a, atrPct, ratio: +ratio.toFixed(3), spreadBps,
    spreadOk,
    tradable: state !== "dead" && state !== "extreme" && spreadOk,
    score: Math.max(0, Math.round(stateScore - spreadPenalty)),
  };
}

// ---------------------------------------------------------------------------
// Multi-timeframe confirmation (1D, 4H, 1H, 15M, 5M)
// ---------------------------------------------------------------------------
export const MTF_ORDER = ["1d", "4h", "1h", "15m", "5m"] as const;
export type Timeframe = (typeof MTF_ORDER)[number];
export type Bias = "bullish" | "bearish" | "neutral";

const MTF_WEIGHT: Record<Timeframe, number> = { "1d": 0.3, "4h": 0.25, "1h": 0.2, "15m": 0.15, "5m": 0.1 };

export interface MtfRead {
  biases: Record<Timeframe, Bias>;
  aligned: number;
  opposed: number;
  score: number;      // 0..100 weighted
  confirmed: boolean; // HTF (1d+4h+1h) must not oppose and ≥2 must agree
}

export function biasFromCandles(candles: Candle[]): Bias {
  if (candles.length < 25) return "neutral";
  const closes = candles.map(c => c.close);
  const fast = ema(closes, 20);
  const slow = ema(closes, Math.min(50, closes.length - 1));
  if (fast === null || slow === null) return "neutral";
  const spread = (fast - slow) / slow;
  if (spread > 0.0008) return "bullish";
  if (spread < -0.0008) return "bearish";
  return "neutral";
}

export function multiTimeframeConfirmation(
  biases: Partial<Record<Timeframe, Bias>>, side: Side,
): MtfRead {
  const want: Bias = side === "buy" ? "bullish" : "bearish";
  const filled = {} as Record<Timeframe, Bias>;
  let score = 0, aligned = 0, opposed = 0;
  for (const tf of MTF_ORDER) {
    const b = biases[tf] ?? "neutral";
    filled[tf] = b;
    if (b === want) { score += MTF_WEIGHT[tf] * 100; aligned++; }
    else if (b !== "neutral") { opposed++; }
    else { score += MTF_WEIGHT[tf] * 45; }
  }
  const htf: Timeframe[] = ["1d", "4h", "1h"];
  const htfAligned = htf.filter(tf => filled[tf] === want).length;
  const htfOpposed = htf.filter(tf => filled[tf] !== want && filled[tf] !== "neutral").length;
  return {
    biases: filled, aligned, opposed,
    score: +score.toFixed(1),
    confirmed: htfAligned >= 2 && htfOpposed <= 1,
  };
}

// ---------------------------------------------------------------------------
// Entry timing components
// ---------------------------------------------------------------------------
export interface TimingInputs {
  candles: Candle[];       // entry timeframe (5m/15m)
  side: Side;
  spreadBps?: number | null;
  maxSpreadBps?: number;
  session?: TradingSession;
  sessionStats?: SessionStat[];
  mtf: MtfRead;
  now?: Date;
}

export interface EntryComponent { key: string; label: string; score: number; weight: number; detail: string; }

export interface EntryWeights {
  mtf: number; pullback: number; vwap: number; structure: number;
  liquidity: number; volatility: number; session: number; momentum: number;
}

export const DEFAULT_WEIGHTS: EntryWeights = {
  mtf: 0.22, pullback: 0.16, vwap: 0.12, structure: 0.14,
  liquidity: 0.10, volatility: 0.10, session: 0.08, momentum: 0.08,
};

export function normalizeWeights(w: EntryWeights): EntryWeights {
  const total = Object.values(w).reduce((s, x) => s + x, 0);
  if (total <= 0) return DEFAULT_WEIGHTS;
  const out = {} as EntryWeights;
  for (const k of Object.keys(w) as (keyof EntryWeights)[]) out[k] = +(w[k] / total).toFixed(4);
  return out;
}

/** Distance score: 100 when price hugs the reference, 0 at `maxAtr` ATR away. */
export function distanceScore(distance: number, atrValue: number, maxAtr = 2): number {
  if (!(atrValue > 0)) return 50;
  const n = Math.abs(distance) / atrValue;
  return Math.max(0, Math.round(100 * (1 - Math.min(1, n / maxAtr))));
}

/** Retracement quality: ideal pullback is 30–62% of the last impulse leg. */
export function pullbackScore(candles: Candle[], side: Side, lookback = 60): { score: number; retrace: number } {
  const c = candles.slice(-lookback);
  if (c.length < 10) return { score: 50, retrace: 0 };
  const high = Math.max(...c.map(k => k.high));
  const low = Math.min(...c.map(k => k.low));
  const range = high - low;
  const last = c[c.length - 1].close;
  if (!(range > 0)) return { score: 50, retrace: 0 };
  const retrace = side === "buy" ? (high - last) / range : (last - low) / range;
  const r = Math.max(0, Math.min(1, retrace));
  // Triangular preference peaking at 0.46 between 0.20 and 0.70.
  let score: number;
  if (r < 0.05) score = 25;            // chasing an extended move
  else if (r <= 0.46) score = 40 + (r - 0.05) / 0.41 * 60;
  else if (r <= 0.72) score = 100 - (r - 0.46) / 0.26 * 35;
  else score = Math.max(15, 65 - (r - 0.72) / 0.28 * 50); // trend likely broken
  return { score: Math.round(score), retrace: +r.toFixed(3) };
}

export interface EntryTimingResult {
  score: number;                 // 0..100
  grade: Grade;
  components: EntryComponent[];
  volatility: VolatilityRead | null;
  structure: StructureEvent;
  sweep: boolean;
  pools: LiquidityPool[];
  session: TradingSession;
  sessionScore: number;
  retrace: number;
  vwap: number | null;
  price: number;
  atr: number;
  notes: string[];
}

export function evaluateEntryTiming(input: TimingInputs, weights: EntryWeights = DEFAULT_WEIGHTS): EntryTimingResult | null {
  const { candles, side } = input;
  if (candles.length < 30) return null;
  const w = normalizeWeights(weights);
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const vol = volatilityEngine(candles, input.spreadBps ?? null, input.maxSpreadBps ?? 30);
  const atrV = vol?.atr ?? atr(candles, 14) ?? 0;
  const notes: string[] = [];

  // 1. Multi-timeframe
  const mtfScore = input.mtf.score;

  // 2. Pullback quality
  const pb = pullbackScore(candles, side);

  // 3. VWAP / EMA proximity
  const vw = vwap(candles, 60);
  const e20 = ema(closes, 20);
  const vwapPart = vw !== null ? distanceScore(price - vw, atrV, 2) : 50;
  const emaPart = e20 !== null ? distanceScore(price - e20, atrV, 1.5) : 50;
  const anchorScore = Math.round(vwapPart * 0.55 + emaPart * 0.45);
  // Trading against VWAP into a strong move is penalised.
  const wrongSideOfVwap = vw !== null && (side === "buy" ? price < vw * 0.995 : price > vw * 1.005);
  if (wrongSideOfVwap) notes.push("Price sits on the wrong side of VWAP for this direction");

  // 4. Structure (BOS / CHoCH)
  const structure = marketStructure(candles);
  const wantUp = side === "buy";
  const structureScore =
    structure === (wantUp ? "bos_up" : "bos_down") ? 100
      : structure === (wantUp ? "choch_up" : "choch_down") ? 78
        : structure === "none" ? 50
          : 12; // structure broke against us

  // 5. Order flow / liquidity
  const pools = liquidityPools(candles);
  const sweep = liquiditySweep(candles, side);
  const ahead = pools.filter(p => (wantUp ? p.side === "above" : p.side === "below"));
  const behind = pools.filter(p => (wantUp ? p.side === "below" : p.side === "above"));
  const nearestAhead = ahead.length
    ? Math.min(...ahead.map(p => Math.abs(p.price - price))) : null;
  // Liquidity resting ahead is a magnet (good) unless it is right on top of us.
  const magnet = nearestAhead === null ? 55
    : nearestAhead < atrV * 0.4 ? 30
      : distanceScore(Math.max(0, nearestAhead - atrV * 1.2), atrV, 4);
  const liquidityScore = Math.min(100, Math.round(magnet * 0.6 + (sweep ? 100 : 45) * 0.3 + (behind.length ? 100 : 55) * 0.1));
  if (sweep) notes.push("Opposing liquidity was swept and reclaimed before entry");

  // 6. Volatility
  const volatilityScore = vol?.score ?? 40;
  if (vol && !vol.tradable) notes.push(`Volatility state ${vol.state}${vol.spreadOk ? "" : " with spread over budget"}`);

  // 7. Session
  const session = input.session ?? classifySession(input.now);
  const sScore = sessionScore(session, input.sessionStats);

  // 8. Momentum
  const m = macd(closes, 12, 26, 9);
  const r = rsi(closes, 14);
  const a = adx(candles, 14);
  let momentum = 50;
  if (m) momentum += (wantUp ? m.histogram > 0 : m.histogram < 0) ? 20 : -25;
  if (r != null) {
    const healthy = wantUp ? r > 45 && r < 76 : r < 55 && r > 24;
    momentum += healthy ? 15 : -20;
  }
  if (a) momentum += a.adx >= 20 ? 15 : -10;
  momentum = Math.max(0, Math.min(100, momentum));

  const components: EntryComponent[] = [
    { key: "mtf", label: "Multi-timeframe alignment", score: mtfScore, weight: w.mtf,
      detail: MTF_ORDER.map(tf => `${tf.toUpperCase()} ${input.mtf.biases[tf]}`).join(" · ") },
    { key: "pullback", label: "Pullback quality", score: pb.score, weight: w.pullback,
      detail: `${(pb.retrace * 100).toFixed(0)}% retracement of the recent leg` },
    { key: "vwap", label: "VWAP / EMA distance", score: wrongSideOfVwap ? Math.round(anchorScore * 0.6) : anchorScore, weight: w.vwap,
      detail: vw !== null ? `${(Math.abs(price - vw) / (atrV || 1)).toFixed(2)} ATR from VWAP` : "VWAP unavailable" },
    { key: "structure", label: "Market structure", score: structureScore, weight: w.structure,
      detail: structure === "none" ? "No fresh break of structure" : structure.replace("_", " ").toUpperCase() },
    { key: "liquidity", label: "Order flow / liquidity", score: liquidityScore, weight: w.liquidity,
      detail: `${pools.length} pools mapped${sweep ? ", sweep confirmed" : ""}` },
    { key: "volatility", label: "Volatility & spread", score: volatilityScore, weight: w.volatility,
      detail: vol ? `${vol.state} (${vol.ratio}× average ATR)${vol.spreadBps != null ? `, ${vol.spreadBps.toFixed(1)} bps spread` : ""}` : "ATR unavailable" },
    { key: "session", label: "Session quality", score: sScore, weight: w.session,
      detail: session.replace(/_/g, " ") },
    { key: "momentum", label: "Momentum", score: momentum, weight: w.momentum,
      detail: `RSI ${r?.toFixed(1) ?? "n/a"}, MACD ${m ? m.histogram.toFixed(5) : "n/a"}, ADX ${a?.adx.toFixed(1) ?? "n/a"}` },
  ];

  const score = +components.reduce((s, c) => s + c.score * c.weight, 0).toFixed(1);

  return {
    score, grade: gradeFor(score), components, volatility: vol, structure, sweep, pools,
    session, sessionScore: sScore, retrace: pb.retrace, vwap: vw, price, atr: atrV, notes,
  };
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------
export type Grade = "A+" | "A" | "B" | "C" | "D" | "F";

export function gradeFor(score: number): Grade {
  if (score >= 90) return "A+";
  if (score >= 82) return "A";
  if (score >= 72) return "B";
  if (score >= 62) return "C";
  if (score >= 50) return "D";
  return "F";
}

// ---------------------------------------------------------------------------
// Smart order type
// ---------------------------------------------------------------------------
export type SmartOrderType = "market" | "limit" | "stop";
export interface OrderPlan { type: SmartOrderType; price: number | null; reason: string; }

export function chooseOrderType(args: {
  side: Side; price: number; atr: number; retrace: number;
  structure: StructureEvent; volatility: VolatilityState; vwap: number | null;
}): OrderPlan {
  const { side, price, atr: a, retrace, structure, volatility } = args;
  const dir = side === "buy" ? 1 : -1;
  const breakout = structure === (side === "buy" ? "bos_up" : "bos_down");

  // Momentum breakout in a healthy tape → stop entry just beyond the break.
  if (breakout && retrace < 0.15 && volatility !== "extreme") {
    return {
      type: "stop",
      price: +(price + dir * a * 0.15).toFixed(8),
      reason: "Breakout confirmed — stop entry above the break to avoid a fakeout fill",
    };
  }
  // Deep retracement or wide spread/volatility → wait for a better price.
  if (retrace > 0.4 || volatility === "elevated") {
    return {
      type: "limit",
      price: +(price - dir * a * 0.35).toFixed(8),
      reason: "Pullback in progress — limit entry at the value area for a tighter stop",
    };
  }
  return { type: "market", price: null, reason: "Clean continuation — immediate market execution" };
}

// ---------------------------------------------------------------------------
// Dynamic SL / TP
// ---------------------------------------------------------------------------
export interface DynamicFrame {
  entry: number; stopLoss: number; takeProfit: number;
  riskReward: number; stopAtrMult: number; stopDistance: number;
  basis: "atr" | "structure";
}

export function dynamicFrame(args: {
  candles: Candle[]; side: Side; entry?: number;
  volatility: VolatilityState; adxValue?: number | null; entryScore: number;
  minRR?: number; maxRR?: number;
}): DynamicFrame | null {
  const { candles, side, volatility, entryScore } = args;
  const a = atr(candles, 14);
  const entry = args.entry ?? candles[candles.length - 1]?.close;
  if (!a || !entry || a <= 0) return null;

  // Stop: 1.5 ATR in calm tape → 3 ATR when volatility expands.
  let mult = 1.5;
  if (volatility === "elevated") mult = 2.2;
  else if (volatility === "extreme") mult = 3;
  else if (volatility === "low" || volatility === "dead") mult = 1.6;

  const structural = side === "buy" ? lastSwingLow(candles) : lastSwingHigh(candles);
  const structuralDist = structural !== null ? Math.abs(entry - structural) * 1.05 : 0;
  const atrDist = a * mult;
  const basis: "atr" | "structure" = structuralDist > atrDist ? "structure" : "atr";
  const stopDistance = Math.min(Math.max(atrDist, structuralDist), a * 3);

  // Reward: 1:2 floor, scaling toward 1:5 with entry quality and trend strength.
  const minRR = args.minRR ?? 2;
  const maxRR = args.maxRR ?? 5;
  const strength = Math.max(0, Math.min(1, ((args.adxValue ?? 20) - 18) / 22));
  const quality = Math.max(0, Math.min(1, (entryScore - 60) / 35));
  let rr = minRR + (maxRR - minRR) * (0.55 * quality + 0.45 * strength);
  if (volatility === "extreme") rr = Math.min(rr, 2.5);
  rr = +Math.max(minRR, Math.min(maxRR, rr)).toFixed(2);

  const dir = side === "buy" ? 1 : -1;
  return {
    entry: +entry.toFixed(8),
    stopLoss: +(entry - dir * stopDistance).toFixed(8),
    takeProfit: +(entry + dir * stopDistance * rr).toFixed(8),
    riskReward: rr,
    stopAtrMult: +(stopDistance / a).toFixed(2),
    stopDistance: +stopDistance.toFixed(8),
    basis,
  };
}

// ---------------------------------------------------------------------------
// Trailing + partial plan
// ---------------------------------------------------------------------------
export interface ManagementPlan {
  breakEvenAtR: number;
  trailStartR: number;
  trailAtrMult: number;
  partials: Array<{ atR: number; closePct: number }>;
}

export function managementPlan(volatility: VolatilityState): ManagementPlan {
  return {
    breakEvenAtR: 1,
    trailStartR: 2,
    trailAtrMult: volatility === "extreme" ? 2.5 : volatility === "elevated" ? 2 : 1.5,
    partials: [
      { atR: 1, closePct: 0.25 },
      { atR: 2, closePct: 0.25 },
      { atR: 3, closePct: 0.25 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Expected value
// ---------------------------------------------------------------------------
export function winProbability(entryScore: number, mtfConfirmed: boolean): number {
  const base = 0.30 + (Math.max(0, Math.min(100, entryScore)) / 100) * 0.42;
  return +Math.max(0.05, Math.min(0.92, base + (mtfConfirmed ? 0.05 : -0.05))).toFixed(4);
}

export function expectedValueR(p: number, rr: number): number {
  return +(p * rr - (1 - p) * 1).toFixed(4);
}

// ---------------------------------------------------------------------------
// Learning — entry-timing classification and weight re-optimisation
// ---------------------------------------------------------------------------
export type EntryTiming = "perfect" | "late" | "early" | "invalid";

export function classifyEntryTiming(t: {
  maxAdverseExcursionR: number; maxFavorableExcursionR: number; rMultiple: number;
}): EntryTiming {
  if (t.maxFavorableExcursionR < 0.3 && t.rMultiple <= 0) return "invalid";
  if (t.maxAdverseExcursionR >= 0.7) return "early";      // entered before the turn
  if (t.maxFavorableExcursionR >= 1.5 && t.rMultiple < 0.5) return "late"; // chased, gave it back
  return "perfect";
}

export interface MemorySample {
  components: Record<string, number>;   // component key → score at entry
  rMultiple: number;
}

/**
 * Re-optimises component weights from trade memory: components that scored
 * high on winners and low on losers gain weight. Movement is capped at ±35%
 * per cycle so the model drifts rather than lurches.
 */
export function reoptimizeWeights(
  current: EntryWeights, samples: MemorySample[], minSamples = 50,
): { weights: EntryWeights; changed: boolean; deltas: Record<string, number> } {
  const deltas: Record<string, number> = {};
  if (samples.length < minSamples) return { weights: current, changed: false, deltas };

  const keys = Object.keys(current) as (keyof EntryWeights)[];
  const next = { ...current };
  for (const key of keys) {
    const rows = samples.filter(s => typeof s.components[key] === "number");
    if (rows.length < Math.max(20, minSamples / 2)) { deltas[key] = 0; continue; }
    const mean = rows.reduce((s, x) => s + x.components[key], 0) / rows.length;
    const meanR = rows.reduce((s, x) => s + x.rMultiple, 0) / rows.length;
    let cov = 0, varC = 0;
    for (const row of rows) {
      cov += (row.components[key] - mean) * (row.rMultiple - meanR);
      varC += (row.components[key] - mean) ** 2;
    }
    const slope = varC > 0 ? cov / varC : 0;
    // Normalise the slope into a bounded multiplier.
    const adj = Math.max(-0.35, Math.min(0.35, slope * 12));
    deltas[key] = +adj.toFixed(4);
    next[key] = Math.max(0.02, current[key] * (1 + adj));
  }
  const weights = normalizeWeights(next);
  const changed = keys.some(k => Math.abs(weights[k] - current[k]) > 0.002);
  return { weights, changed, deltas };
}

// ---------------------------------------------------------------------------
// Welch's t-test — promote a new model only at ≥95% confidence
// ---------------------------------------------------------------------------
function erf(x: number): number {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

export interface TTestResult { t: number; pValue: number; confidence: number; significant: boolean; }

export function welchTTest(a: number[], b: number[]): TTestResult {
  if (a.length < 5 || b.length < 5) return { t: 0, pValue: 1, confidence: 0, significant: false };
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const varr = (x: number[], m: number) => x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1);
  const ma = mean(a), mb = mean(b);
  const va = varr(a, ma), vb = varr(b, mb);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!(se > 0)) return { t: 0, pValue: 1, confidence: 0, significant: false };
  const t = (ma - mb) / se;
  // Normal approximation of the two-sided p-value (samples here are ≥30).
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)));
  const pValue = +Math.max(0, Math.min(1, p)).toFixed(5);
  return { t: +t.toFixed(4), pValue, confidence: +((1 - pValue) * 100).toFixed(2), significant: pValue < 0.05 && t > 0 };
}
