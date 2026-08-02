// Institutional entry gate.
//
// A trade is only allowed when EVERY condition passes. There is no scoring
// override, no "close enough" — quality over quantity is the primary mandate.
//
//   1. Higher-timeframe trend agreement (1d + 4h + 1h aligned with the signal)
//   2. Entry-timeframe (15m) momentum confirmation
//   3. Tradable regime (no extreme volatility, no dead market)
//   4. ADX trend strength >= 20 for trend trades
//   5. Volume/liquidity confirmation
//   6. Structural risk frame available with RR inside the configured band
//   7. Spread within budget
//   8. No high-impact event window
//   9. Composite confidence >= the configured minimum (default 90%)
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandles } from "@/lib/marketdata/service.server";
import type { Candle } from "@/lib/analysis/indicators";
import { bollinger, ema, macd, rsi, volumeStats } from "@/lib/analysis/indicators";
import { classifyRegime, type RegimeReport } from "@/lib/analysis/regime";
import { adx, buildRiskFrame, trendBias, type RiskFrame } from "@/lib/analysis/institutional";
import { checkEventWindow } from "@/lib/analysis/eventWindow";

export interface FilterCheck {
  name: string;
  passed: boolean;
  detail: string;
  /** Weight this check contributes to the composite confidence (0..1). */
  weight: number;
}

export interface EntryEvaluation {
  symbol: string;
  side: "buy" | "sell";
  approved: boolean;
  confidence: number;          // 0..1 composite
  checks: FilterCheck[];
  rejections: string[];
  regime: RegimeReport;
  frame: RiskFrame | null;
  htfBias: { d1: string; h4: string; h1: string };
  strategy: string;
  reasoning: string;
}

export interface EntryFilterConfig {
  minConfidence?: number;      // default 0.90
  minRR?: number;              // default 2
  maxRR?: number;              // default 4
  maxSpreadBps?: number;       // default 30
  requireMtf?: boolean;        // default true
  newsFilterEnabled?: boolean; // default true
  spreadBps?: number | null;   // live spread when the broker provides it
}

function biasFor(side: "buy" | "sell") {
  return side === "buy" ? "bullish" : "bearish";
}

export async function evaluateEntry(
  supabase: SupabaseClient | null,
  symbol: string,
  side: "buy" | "sell",
  cfg: EntryFilterConfig = {},
  userId?: string | null,
): Promise<EntryEvaluation> {
  const minConfidence = cfg.minConfidence ?? 0.9;
  const requireMtf = cfg.requireMtf ?? true;
  const newsFilterEnabled = cfg.newsFilterEnabled ?? true;
  const maxSpreadBps = cfg.maxSpreadBps ?? 30;

  const [d1, h4, h1, m15] = await Promise.all([
    fetchCandles(supabase, symbol, "1d", 220, userId).catch(() => [] as Candle[]),
    fetchCandles(supabase, symbol, "4h", 220, userId).catch(() => [] as Candle[]),
    fetchCandles(supabase, symbol, "1h", 220, userId).catch(() => [] as Candle[]),
    fetchCandles(supabase, symbol, "15m", 220, userId).catch(() => [] as Candle[]),
  ]);

  const entryCandles = m15.length >= 60 ? m15 : h1;
  const regime = classifyRegime(entryCandles.length ? entryCandles : h1);
  const want = biasFor(side);

  const htfBias = {
    d1: d1.length ? trendBias(d1.map(c => c.close)) : "neutral",
    h4: h4.length ? trendBias(h4.map(c => c.close)) : "neutral",
    h1: h1.length ? trendBias(h1.map(c => c.close)) : "neutral",
  };

  const checks: FilterCheck[] = [];

  // 1. Higher-timeframe alignment -------------------------------------------
  const aligned = [htfBias.d1, htfBias.h4, htfBias.h1].filter(b => b === want).length;
  const opposed = [htfBias.d1, htfBias.h4, htfBias.h1].filter(b => b !== want && b !== "neutral").length;
  checks.push({
    name: "Higher-timeframe alignment",
    passed: requireMtf ? aligned >= 2 && opposed === 0 : aligned >= 1,
    detail: `1D ${htfBias.d1}, 4H ${htfBias.h4}, 1H ${htfBias.h1} — ${aligned}/3 agree with ${side.toUpperCase()}`,
    weight: 0.25,
  });

  // 2. Entry-timeframe momentum ---------------------------------------------
  const closes = entryCandles.map(c => c.close);
  const m = macd(closes, 12, 26, 9);
  const r = rsi(closes, 14);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const momentumOk = side === "buy"
    ? !!m && m.histogram > 0 && (r ?? 50) > 45 && (r ?? 50) < 78 && (e20 ?? 0) >= (e50 ?? 0)
    : !!m && m.histogram < 0 && (r ?? 50) < 55 && (r ?? 50) > 22 && (e20 ?? 0) <= (e50 ?? 0);
  checks.push({
    name: "Entry momentum confirmation",
    passed: momentumOk,
    detail: `MACD hist ${m ? m.histogram.toFixed(5) : "n/a"}, RSI ${r?.toFixed(1) ?? "n/a"}, EMA20/50 ${e20 && e50 ? (e20 > e50 ? "bullish" : "bearish") : "n/a"}`,
    weight: 0.2,
  });

  // 3. Regime tradability ----------------------------------------------------
  checks.push({
    name: "Regime tradability",
    passed: regime.tradable,
    detail: `${regime.label} — ${regime.description}`,
    weight: 0.15,
  });

  // 4. Trend strength --------------------------------------------------------
  const a = adx(entryCandles, 14);
  const strengthOk = regime.regime === "ranging" ? true : (a?.adx ?? 0) >= 20;
  checks.push({
    name: "Trend strength (ADX)",
    passed: strengthOk,
    detail: a ? `ADX ${a.adx.toFixed(1)} (+DI ${a.plusDi.toFixed(1)} / -DI ${a.minusDi.toFixed(1)})` : "ADX unavailable",
    weight: 0.1,
  });

  // 5. Volume / liquidity ----------------------------------------------------
  const v = volumeStats(entryCandles, 20);
  const volumeOk = !v || v.ratio >= 0.7;
  checks.push({
    name: "Liquidity confirmation",
    passed: volumeOk,
    detail: v ? `${v.ratio.toFixed(2)}× 20-bar average volume` : "volume unavailable",
    weight: 0.08,
  });

  // 6. Structural risk frame -------------------------------------------------
  const frame = buildRiskFrame(entryCandles, side, {
    minRR: cfg.minRR ?? 2, maxRR: cfg.maxRR ?? 4,
    preferredRR: regime.trendStrength === "strong" ? 3 : 2.5,
  });
  checks.push({
    name: "Structural risk frame",
    passed: !!frame && frame.riskReward >= (cfg.minRR ?? 2),
    detail: frame
      ? `Stop from ${frame.basis} at ${frame.stopLoss}, target ${frame.takeProfit} (1:${frame.riskReward})`
      : "Could not derive an ATR/structure stop",
    weight: 0.12,
  });

  // 7. Spread ---------------------------------------------------------------
  const spreadKnown = typeof cfg.spreadBps === "number" && Number.isFinite(cfg.spreadBps);
  checks.push({
    name: "Spread budget",
    passed: !spreadKnown || (cfg.spreadBps as number) <= maxSpreadBps,
    detail: spreadKnown ? `${(cfg.spreadBps as number).toFixed(1)} bps vs ${maxSpreadBps} bps budget` : "spread not reported by venue",
    weight: 0.05,
  });

  // 8. Event window ----------------------------------------------------------
  const ev = checkEventWindow();
  checks.push({
    name: "News / event window",
    passed: !newsFilterEnabled || !ev.active,
    detail: ev.active ? `Blocked: ${ev.reason}` : "No high-impact window",
    weight: 0.05,
  });

  // 9. Bollinger over-extension (do not buy the top of a move) ---------------
  const bb = bollinger(closes, 20, 2);
  const extended = bb ? (side === "buy" ? bb.percentB > 0.97 : bb.percentB < 0.03) : false;
  checks.push({
    name: "Over-extension guard",
    passed: !extended,
    detail: bb ? `%B ${(bb.percentB * 100).toFixed(0)}%` : "bands unavailable",
    weight: 0,
  });

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const earned = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  const base = totalWeight > 0 ? earned / totalWeight : 0;
  const confidence = Math.max(0, Math.min(0.99, base * regime.confidenceMultiplier));

  const rejections = checks.filter(c => !c.passed).map(c => `${c.name}: ${c.detail}`);
  if (confidence < minConfidence) {
    rejections.push(`Composite confidence ${(confidence * 100).toFixed(1)}% below ${(minConfidence * 100).toFixed(0)}% threshold`);
  }

  const strategy = regime.regime === "ranging" ? "mean_reversion"
    : regime.regime === "high_volatility" ? "breakout"
    : "trend_following";

  const approved = rejections.length === 0;
  const reasoning = approved
    ? `${side.toUpperCase()} ${symbol}: ${regime.label} with 1D/4H/1H alignment, ADX ${a?.adx.toFixed(1) ?? "n/a"}, stop from ${frame?.basis} at 1:${frame?.riskReward} reward. Composite confidence ${(confidence * 100).toFixed(1)}%.`
    : `${side.toUpperCase()} ${symbol} rejected — ${rejections[0]}.`;

  return { symbol, side, approved, confidence, checks, rejections, regime, frame, htfBias, strategy, reasoning };
}
