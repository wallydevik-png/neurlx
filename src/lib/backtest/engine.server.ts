// Historical backtesting engine. Replays candles bar-by-bar, generates
// AI signals with the same explainable engine used live, and simulates
// entries/exits with fees + slippage. Server-only.
import type { Candle } from "@/lib/analysis/indicators";
import { atr } from "@/lib/analysis/indicators";
import { fetchCandles } from "@/lib/marketdata/service.server";
import { analyzeCandles } from "@/lib/trading/aiEngine.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeMetrics, type BacktestMetrics, type EquityPoint } from "./metrics";

export interface BacktestParams {
  symbol: string;
  interval: "5m" | "15m" | "1h" | "4h" | "1d";
  bars: number;              // total bars to load (warmup + walk)
  warmup?: number;           // bars before signals start (default 60)
  minConfidence?: number;    // default 0.55
  feeBps?: number;           // per side (default 10 bps)
  slippageBps?: number;      // per side (default 5 bps)
  startingCapital?: number;  // default 10_000
  riskPerTradePct?: number;  // % of equity risked per trade (SL distance) — default 1%
  maxBarsInTrade?: number;   // time exit (default 40)
  rangeStart?: number;       // optional slice within loaded bars (index)
  rangeEnd?: number;         // optional slice within loaded bars (index)
}

export interface SimulatedTrade {
  symbol: string;
  side: "long" | "short";
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPct: number;
  exitReason: "stop_loss" | "take_profit" | "time_exit" | "end_of_data";
  confidence: number;
  regime: string;
  indicators: Record<string, unknown>;
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  fromTs: number;
  toTs: number;
  params: Required<Omit<BacktestParams, "rangeStart" | "rangeEnd">>;
  trades: SimulatedTrade[];
  equity: EquityPoint[];
  metrics: BacktestMetrics;
}

const DEFAULTS = {
  warmup: 60, minConfidence: 0.55, feeBps: 10, slippageBps: 5,
  startingCapital: 10_000, riskPerTradePct: 0.01, maxBarsInTrade: 40,
};

export async function runBacktest(
  supabase: SupabaseClient | null,
  params: BacktestParams,
): Promise<BacktestResult> {
  const p = { ...DEFAULTS, ...params };
  const all = await fetchCandles(supabase, p.symbol, p.interval, p.bars);
  const start = Math.max(p.warmup, params.rangeStart ?? p.warmup);
  const end = Math.min(all.length, params.rangeEnd ?? all.length);

  let equity = p.startingCapital;
  const equityCurve: EquityPoint[] = [{ ts: all[start - 1]?.ts ?? Date.now(), equity }];
  const trades: SimulatedTrade[] = [];

  let position: null | {
    side: "long" | "short"; entryPrice: number; qty: number;
    sl: number; tp: number; entryTs: number; openedAtBar: number;
    confidence: number; regime: string; indicators: Record<string, unknown>;
  } = null;

  for (let i = start; i < end; i++) {
    const window = all.slice(0, i + 1);
    const bar = all[i];

    // Manage open position: check intrabar stop/target hits first.
    if (position) {
      const dir = position.side === "long" ? 1 : -1;
      let exitPrice: number | null = null;
      let exitReason: SimulatedTrade["exitReason"] | null = null;
      if (position.side === "long") {
        if (bar.low <= position.sl) { exitPrice = position.sl; exitReason = "stop_loss"; }
        else if (bar.high >= position.tp) { exitPrice = position.tp; exitReason = "take_profit"; }
      } else {
        if (bar.high >= position.sl) { exitPrice = position.sl; exitReason = "stop_loss"; }
        else if (bar.low <= position.tp) { exitPrice = position.tp; exitReason = "take_profit"; }
      }
      if (exitPrice === null && i - position.openedAtBar >= p.maxBarsInTrade) {
        exitPrice = bar.close; exitReason = "time_exit";
      }
      if (exitPrice !== null && exitReason) {
        // Apply exit slippage against direction + fee both sides.
        const slippedExit = exitPrice * (1 - dir * p.slippageBps / 10_000);
        const grossPnl = (slippedExit - position.entryPrice) * dir * position.qty;
        const notionalEntry = position.entryPrice * position.qty;
        const notionalExit = slippedExit * position.qty;
        const fees = (notionalEntry + notionalExit) * (p.feeBps / 10_000);
        const pnl = grossPnl - fees;
        equity += pnl;
        equityCurve.push({ ts: bar.ts, equity: +equity.toFixed(2) });
        trades.push({
          symbol: p.symbol, side: position.side,
          entryTs: position.entryTs, entryPrice: position.entryPrice,
          exitTs: bar.ts, exitPrice: +slippedExit.toFixed(6),
          qty: position.qty, pnl: +pnl.toFixed(2), pnlPct: pnl / notionalEntry,
          exitReason, confidence: position.confidence,
          regime: position.regime, indicators: position.indicators,
        });
        position = null;
      }
    }

    // Look for a new entry only when flat.
    if (!position) {
      const signal = analyzeCandles(p.symbol, window);
      if (signal.direction !== "wait" && signal.confidence >= p.minConfidence) {
        const side: "long" | "short" = signal.direction === "buy" ? "long" : "short";
        const dir = side === "long" ? 1 : -1;
        const entry = bar.close * (1 + dir * p.slippageBps / 10_000);
        const slDist = Math.abs(entry - signal.stopLoss) || (atr(window, 14) ?? entry * 0.02) * 1.5;
        // Position size from % risk per trade.
        const riskDollars = equity * p.riskPerTradePct;
        const qty = +(riskDollars / slDist).toFixed(6);
        if (qty > 0) {
          position = {
            side, entryPrice: +entry.toFixed(6), qty,
            sl: signal.stopLoss, tp: signal.takeProfit,
            entryTs: bar.ts, openedAtBar: i,
            confidence: signal.confidence, regime: signal.regime,
            indicators: signal.indicators,
          };
        }
      }
    }
  }

  // Close any dangling position at last close.
  if (position) {
    const lastBar = all[end - 1];
    const dir = position.side === "long" ? 1 : -1;
    const exitPrice = lastBar.close * (1 - dir * p.slippageBps / 10_000);
    const grossPnl = (exitPrice - position.entryPrice) * dir * position.qty;
    const notional = position.entryPrice * position.qty;
    const fees = (notional + exitPrice * position.qty) * (p.feeBps / 10_000);
    const pnl = grossPnl - fees;
    equity += pnl;
    equityCurve.push({ ts: lastBar.ts, equity: +equity.toFixed(2) });
    trades.push({
      symbol: p.symbol, side: position.side,
      entryTs: position.entryTs, entryPrice: position.entryPrice,
      exitTs: lastBar.ts, exitPrice: +exitPrice.toFixed(6),
      qty: position.qty, pnl: +pnl.toFixed(2), pnlPct: pnl / notional,
      exitReason: "end_of_data", confidence: position.confidence,
      regime: position.regime, indicators: position.indicators,
    });
  }

  const metrics = computeMetrics(
    trades.map(t => ({ pnl: t.pnl, pnlPct: t.pnlPct })),
    equityCurve,
    p.startingCapital,
  );

  return {
    symbol: p.symbol, interval: p.interval,
    fromTs: all[start - 1]?.ts ?? all[0].ts, toTs: all[end - 1].ts,
    params: p, trades, equity: equityCurve, metrics,
  };
}

// Walk-forward: split loaded range into training / validation / OOS windows.
// Returns three backtests over identical parameters so the user can compare
// in-sample vs out-of-sample performance and spot overfitting.
export async function runWalkForward(
  supabase: SupabaseClient | null,
  params: BacktestParams,
): Promise<{ train: BacktestResult; validation: BacktestResult; oos: BacktestResult }> {
  const p = { ...DEFAULTS, ...params };
  const total = params.bars;
  const warmup = p.warmup;
  const usable = total - warmup;
  // 50 / 25 / 25 split
  const trainEnd = warmup + Math.floor(usable * 0.5);
  const valEnd = warmup + Math.floor(usable * 0.75);

  const train = await runBacktest(supabase, { ...params, rangeStart: warmup, rangeEnd: trainEnd });
  const validation = await runBacktest(supabase, { ...params, rangeStart: trainEnd, rangeEnd: valEnd });
  const oos = await runBacktest(supabase, { ...params, rangeStart: valEnd, rangeEnd: total });
  return { train, validation, oos };
}
