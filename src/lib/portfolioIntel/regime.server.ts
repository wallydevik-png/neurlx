// Dynamic market regime engine. Classifies each market into one of seven
// institutional regimes and caches the classification for an hour.
import { classifyRegime } from "@/lib/analysis/regime";
import { adx } from "@/lib/analysis/institutional";
import { volumeStats, ema } from "@/lib/analysis/indicators";
import { fetchCandles } from "@/lib/marketdata/service.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { REGIME_LABELS, type MacroRegime } from "./scoring";

export interface MacroRegimeReport {
  symbol: string;
  regime: MacroRegime;
  label: string;
  confidence: number;      // 0..1
  tradable: boolean;
  bias: "bullish" | "bearish" | "neutral";
  volatilityPct: number;
  trendQuality: number;    // 0..1
  volumeRatio: number;
  adx: number | null;
  at: number;
}

const cache = new Map<string, MacroRegimeReport>();
const TTL_MS = 60 * 60 * 1000; // classify every hour

export function classifyMacroRegime(symbol: string, candles: Parameters<typeof classifyRegime>[0]): MacroRegimeReport {
  const base = classifyRegime(candles);
  const closes = candles.map(c => c.close);
  const last = closes[closes.length - 1] ?? 0;
  const a = adx(candles, 14);
  const vol = volumeStats(candles, 20);
  const e50 = ema(closes, 50) ?? last;
  const e200 = ema(closes, Math.min(200, Math.max(50, Math.floor(closes.length / 2)))) ?? e50;
  const above = last > e50 && e50 > e200;
  const below = last < e50 && e50 < e200;
  const adxV = a?.adx ?? 0;
  const volumeRatio = vol?.ratio ?? 1;
  const trendQuality = Math.min(1, adxV / 40);

  let regime: MacroRegime;
  if (base.volatilityPct > 0.06) regime = "panic";
  else if (volumeRatio < 0.4 || base.volatilityPct < 0.004) regime = "low_liquidity";
  else if (base.volatilityPct > 0.035) regime = "high_volatility";
  else if (above && adxV >= 30) regime = "strong_bull";
  else if (above) regime = "bull";
  else if (below && adxV >= 25) regime = "bear";
  else regime = "range";

  const confidence = Math.min(1, Math.max(0.25,
    regime === "range" ? 0.5 + (25 - Math.min(25, adxV)) / 50 : 0.4 + trendQuality * 0.6,
  ));
  const tradable = regime !== "panic" && regime !== "low_liquidity";
  const bias: MacroRegimeReport["bias"] =
    regime === "strong_bull" || regime === "bull" ? "bullish"
    : regime === "bear" ? "bearish" : "neutral";

  return {
    symbol, regime, label: REGIME_LABELS[regime], confidence: +confidence.toFixed(3),
    tradable, bias, volatilityPct: base.volatilityPct, trendQuality: +trendQuality.toFixed(3),
    volumeRatio: +volumeRatio.toFixed(3), adx: a?.adx ?? null, at: Date.now(),
  };
}

export async function getMacroRegime(
  supabase: SupabaseClient | null,
  symbol: string,
  interval: "1h" | "4h" = "1h",
  userId?: string | null,
): Promise<MacroRegimeReport> {
  const key = `${symbol}:${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const candles = await fetchCandles(supabase, symbol, interval, 250, userId);
  const report = classifyMacroRegime(symbol, candles);
  cache.set(key, report);
  return report;
}

/** Persist the hourly classification so the dashboard can show history. */
export async function recordRegime(
  supabase: SupabaseClient, userId: string, r: MacroRegimeReport,
): Promise<void> {
  await supabase.from("market_regime_snapshots").insert({
    user_id: userId, symbol: r.symbol, regime: r.regime, label: r.label,
    confidence: r.confidence, tradable: r.tradable,
    metrics: {
      volatilityPct: r.volatilityPct, trendQuality: r.trendQuality,
      volumeRatio: r.volumeRatio, adx: r.adx, bias: r.bias,
    },
  });
}

/** True when the regime supports the proposed direction. */
export function regimeFavours(r: MacroRegimeReport, side: "buy" | "sell"): boolean {
  if (r.bias === "neutral") return r.regime === "range";
  return (r.bias === "bullish" && side === "buy") || (r.bias === "bearish" && side === "sell");
}
