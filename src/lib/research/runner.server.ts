// Hypothesis runner — bar-by-bar replay of a DSL over cached candles,
// simulating a single-position strategy with ATR stop/target, fees and
// slippage. Returns metrics compatible with the backtest metrics module.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candle } from "@/lib/analysis/indicators";
import { atr } from "@/lib/analysis/indicators";
import { fetchCandles } from "@/lib/marketdata/service.server";
import { computeMetrics, type BacktestMetrics, type EquityPoint } from "@/lib/backtest/metrics";
import { FACTOR_MAP } from "./factors";
import type { Condition, HypothesisDSL, Op, RuleGroup } from "./dsl";

const FEE_BPS = 10;
const SLIP_BPS = 5;

function evalCondition(cond: Condition, hist: Candle[], prev: Candle[] | null): boolean {
  const spec = FACTOR_MAP[cond.factor];
  if (!spec) return false;
  const params = { ...Object.fromEntries(spec.params.map(p => [p.name, p.default])), ...(cond.params ?? {}) };
  const now = spec.eval(hist, params);
  if (now == null) return false;
  const cross = cond.op === "cross_above" || cond.op === "cross_below";
  if (cross) {
    if (!prev) return false;
    const then = spec.eval(prev, params);
    if (then == null) return false;
    if (cond.op === "cross_above") return then <= cond.value && now > cond.value;
    return then >= cond.value && now < cond.value;
  }
  const op: Op = cond.op;
  if (op === ">") return now > cond.value;
  if (op === ">=") return now >= cond.value;
  if (op === "<") return now < cond.value;
  if (op === "<=") return now <= cond.value;
  return Math.abs(now - cond.value) < 1e-9;
}

function evalGroup(g: RuleGroup | undefined, hist: Candle[], prev: Candle[] | null): boolean {
  if (!g) return false;
  if (g.all?.length) return g.all.every(c => evalCondition(c, hist, prev));
  if (g.any?.length) return g.any.some(c => evalCondition(c, hist, prev));
  return false;
}

export interface HypothesisRun {
  symbol: string;
  interval: string;
  bars: number;
  fromTs: number;
  toTs: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  finalEquity: number;
  totalReturnPct: number;
  metrics: BacktestMetrics;
  equity: EquityPoint[];
  sample: Array<{ ts: number; side: "long" | "short"; entry: number; exit: number; pnlPct: number; reason: string }>;
}

export async function runHypothesis(
  supabase: SupabaseClient,
  params: { symbol: string; interval: "5m" | "15m" | "1h" | "4h" | "1d"; bars?: number; dsl: HypothesisDSL },
  userId?: string | null,
): Promise<HypothesisRun> {
  const bars = Math.min(Math.max(params.bars ?? 300, 100), 1000);
  const candles = await fetchCandles(supabase, params.symbol, params.interval, bars, userId);
  if (candles.length < 80) throw new Error("Not enough market data");

  const warmup = 60;
  const startCapital = 10_000;
  let equity = startCapital;
  const equityCurve: EquityPoint[] = [{ ts: candles[warmup - 1]?.ts ?? candles[0].ts, equity }];
  const trades: HypothesisRun["sample"] = [];
  const feeMult = FEE_BPS / 10_000;
  const slipMult = SLIP_BPS / 10_000;

  type Open = { side: "long" | "short"; entryTs: number; entryPrice: number; qty: number; stop: number; take: number; opened: number };
  let open: Open | null = null;

  for (let i = warmup; i < candles.length; i++) {
    const hist = candles.slice(0, i + 1);
    const prev = i > warmup ? candles.slice(0, i) : null;
    const bar = candles[i];

    // Manage open trade
    if (open) {
      let exitPrice: number | null = null;
      let reason = "";
      if (open.side === "long") {
        if (bar.low <= open.stop) { exitPrice = open.stop; reason = "stop_loss"; }
        else if (bar.high >= open.take) { exitPrice = open.take; reason = "take_profit"; }
      } else {
        if (bar.high >= open.stop) { exitPrice = open.stop; reason = "stop_loss"; }
        else if (bar.low <= open.take) { exitPrice = open.take; reason = "take_profit"; }
      }
      const bars = i - open.opened;
      if (exitPrice == null && bars >= (params.dsl.risk.maxBarsInTrade ?? 40)) {
        exitPrice = bar.close; reason = "time_exit";
      }
      if (exitPrice == null && evalGroup(params.dsl.exit, hist, prev)) {
        exitPrice = bar.close; reason = "rule_exit";
      }
      if (exitPrice != null) {
        const slipped = open.side === "long" ? exitPrice * (1 - slipMult) : exitPrice * (1 + slipMult);
        const grossPnl = open.side === "long"
          ? (slipped - open.entryPrice) * open.qty
          : (open.entryPrice - slipped) * open.qty;
        const fee = (open.entryPrice + slipped) * open.qty * feeMult;
        const pnl = grossPnl - fee;
        equity += pnl;
        const pnlPct = (pnl / (open.entryPrice * open.qty)) * 100;
        trades.push({ ts: bar.ts, side: open.side, entry: open.entryPrice, exit: slipped, pnlPct, reason });
        equityCurve.push({ ts: bar.ts, equity });
        open = null;
      }
    }

    // Look for entry
    if (!open) {
      const long = params.dsl.side !== "short" && evalGroup(params.dsl.entry, hist, prev);
      const short = params.dsl.side !== "long" && evalGroup(params.dsl.entry, hist, prev) && params.dsl.side === "short";
      // For side=both, allow long if entry passes for long semantics — DSL author is responsible for symmetry
      if (long || short) {
        const side: "long" | "short" = params.dsl.side === "short" ? "short" : "long";
        const a = atr(hist, 14);
        if (!a || a <= 0) continue;
        const stopDist = a * params.dsl.risk.stopAtrMult;
        const takeDist = a * params.dsl.risk.takeAtrMult;
        const entryRaw = bar.close;
        const entry = side === "long" ? entryRaw * (1 + slipMult) : entryRaw * (1 - slipMult);
        const stop = side === "long" ? entry - stopDist : entry + stopDist;
        const take = side === "long" ? entry + takeDist : entry - takeDist;
        const riskCash = equity * (params.dsl.risk.riskPct / 100);
        const qty = riskCash / stopDist;
        if (qty > 0 && Number.isFinite(qty)) {
          open = { side, entryTs: bar.ts, entryPrice: entry, qty, stop, take, opened: i };
        }
      }
    }
  }

  // Close any remaining
  if (open) {
    const last = candles[candles.length - 1];
    const slipped = open.side === "long" ? last.close * (1 - slipMult) : last.close * (1 + slipMult);
    const grossPnl = open.side === "long"
      ? (slipped - open.entryPrice) * open.qty
      : (open.entryPrice - slipped) * open.qty;
    const fee = (open.entryPrice + slipped) * open.qty * feeMult;
    const pnl = grossPnl - fee;
    equity += pnl;
    trades.push({ ts: last.ts, side: open.side, entry: open.entryPrice, exit: slipped, pnlPct: (pnl / (open.entryPrice * open.qty)) * 100, reason: "end_of_data" });
    equityCurve.push({ ts: last.ts, equity });
  }

  const tradeStats = trades.map(t => ({ pnl: (t.pnlPct / 100) * startCapital, pnlPct: t.pnlPct / 100 }));
  const metrics = computeMetrics(tradeStats, equityCurve, startCapital);
  const wins = trades.filter(t => t.pnlPct > 0).length;
  const losses = trades.filter(t => t.pnlPct <= 0).length;

  return {
    symbol: params.symbol,
    interval: params.interval,
    bars: candles.length,
    fromTs: candles[0].ts,
    toTs: candles[candles.length - 1].ts,
    trades: trades.length,
    wins, losses,
    winRate: trades.length ? wins / trades.length : 0,
    finalEquity: equity,
    totalReturnPct: ((equity - startCapital) / startCapital) * 100,
    metrics,
    equity: equityCurve,
    sample: trades.slice(-20),
  };
}
