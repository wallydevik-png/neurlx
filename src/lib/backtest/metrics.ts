// Pure performance metrics for a completed backtest.
// Inputs are simple arrays so this file is safe on both server and client.

export interface EquityPoint { ts: number; equity: number; }
export interface TradeStat { pnl: number; pnlPct: number; }

export interface BacktestMetrics {
  totalReturn: number;         // absolute (starting capital = 1)
  totalReturnPct: number;      // % of starting capital
  finalEquity: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;             // positive number
  profitFactor: number;        // sum wins / |sum losses|
  sharpe: number;              // per-trade Sharpe, annualisation-agnostic
  sortino: number;
  maxDrawdown: number;         // fraction, 0..1
  maxDrawdownPct: number;
  bestTrade: number;
  worstTrade: number;
  avgTradePnl: number;
  expectancy: number;          // avg P&L per trade / starting capital
}

const EMPTY: BacktestMetrics = {
  totalReturn: 0, totalReturnPct: 0, finalEquity: 1, trades: 0, wins: 0, losses: 0,
  winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0, sharpe: 0, sortino: 0,
  maxDrawdown: 0, maxDrawdownPct: 0, bestTrade: 0, worstTrade: 0, avgTradePnl: 0, expectancy: 0,
};

export function computeMetrics(
  trades: TradeStat[],
  equity: EquityPoint[],
  startingCapital = 10_000,
): BacktestMetrics {
  if (trades.length === 0 || equity.length === 0) return { ...EMPTY, finalEquity: startingCapital };

  const final = equity[equity.length - 1].equity;
  const totalReturn = final - startingCapital;
  const totalReturnPct = totalReturn / startingCapital;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const sumWin = wins.reduce((s, t) => s + t.pnl, 0);
  const sumLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = wins.length ? sumWin / wins.length : 0;
  const avgLoss = losses.length ? sumLoss / losses.length : 0;
  const winRate = trades.length ? wins.length / trades.length : 0;
  const profitFactor = sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0);

  // Per-trade returns for Sharpe/Sortino
  const rets = trades.map(t => t.pnlPct);
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  const downside = Math.sqrt(rets.filter(x => x < 0).reduce((s, x) => s + x * x, 0) / rets.length);
  const sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(trades.length) : 0;
  const sortino = downside > 0 ? (mean / downside) * Math.sqrt(trades.length) : 0;

  // Max drawdown across equity curve
  let peak = equity[0].equity, maxDd = 0;
  for (const pt of equity) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const pnls = trades.map(t => t.pnl);
  const bestTrade = Math.max(...pnls);
  const worstTrade = Math.min(...pnls);
  const avgTradePnl = pnls.reduce((s, x) => s + x, 0) / trades.length;

  return {
    totalReturn, totalReturnPct, finalEquity: final,
    trades: trades.length, wins: wins.length, losses: losses.length,
    winRate, avgWin, avgLoss, profitFactor,
    sharpe, sortino,
    maxDrawdown: maxDd, maxDrawdownPct: maxDd,
    bestTrade, worstTrade, avgTradePnl,
    expectancy: avgTradePnl / startingCapital,
  };
}
