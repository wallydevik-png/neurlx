// Advanced portfolio risk: correlation matrix, historical VaR/CVaR,
// portfolio volatility, portfolio heat, and dynamic position sizing
// (vol-target + fractional-Kelly). Pure math + market-data reads.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandles } from "@/lib/marketdata/service.server";

export interface HoldingRow {
  symbol: string;
  qty: number;
  avgEntry: number;
  stopLoss?: number | null;
  side: "long" | "short";
}

export interface PortfolioRiskReport {
  equity: number;
  openPositions: number;
  portfolioHeatPct: number;      // sum(open risk) / equity  * 100
  perAssetRiskPct: { symbol: string; pct: number }[];
  var95Pct: number;              // daily historical 95% VaR as % of equity
  cvar95Pct: number;             // Expected Shortfall
  portfolioVolPct: number;       // daily stdev of pnl % of equity
  correlationMax: number;
  correlationPairs: { a: string; b: string; corr: number }[];
  riskScore: number;             // 0..100 (higher = riskier)
  advisories: string[];
}

function logReturns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]; const b = closes[i];
    if (a > 0 && b > 0) r.push(Math.log(b / a));
  }
  return r;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((s,x)=>s+x,0)/xs.length : 0; }
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/(xs.length-1));
}
function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const ma = mean(a.slice(-n)); const mb = mean(b.slice(-n));
  let num=0, da=0, db=0;
  for (let i=0;i<n;i++){ const x=a[a.length-n+i]-ma; const y=b[b.length-n+i]-mb; num+=x*y; da+=x*x; db+=y*y; }
  const d = Math.sqrt(da*db); return d===0?0:num/d;
}

export async function computePortfolioRisk(
  supabase: SupabaseClient | null,
  args: { equity: number; holdings: HoldingRow[] },
): Promise<PortfolioRiskReport> {
  const equity = Math.max(1, args.equity);
  const holdings = args.holdings.filter(h => h.qty > 0);
  if (holdings.length === 0) {
    return {
      equity, openPositions: 0, portfolioHeatPct: 0, perAssetRiskPct: [],
      var95Pct: 0, cvar95Pct: 0, portfolioVolPct: 0,
      correlationMax: 0, correlationPairs: [], riskScore: 0,
      advisories: ["No open positions — portfolio risk is zero."],
    };
  }

  // Fetch returns for each held symbol (daily bars, ~120 samples).
  const seriesBySym = new Map<string, { closes: number[]; rets: number[] }>();
  await Promise.all(holdings.map(async h => {
    try {
      const c = await fetchCandles(supabase, h.symbol, "1d", 120);
      const closes = c.map(x => x.close);
      seriesBySym.set(h.symbol, { closes, rets: logReturns(closes) });
    } catch { seriesBySym.set(h.symbol, { closes: [], rets: [] }); }
  }));

  // Weights by notional exposure.
  const notionals = holdings.map(h => {
    const px = seriesBySym.get(h.symbol)?.closes.slice(-1)[0] ?? h.avgEntry;
    return { h, notional: h.qty * px, price: px };
  });
  const totalNotional = notionals.reduce((s,n)=>s+n.notional,0) || 1;
  const weights = notionals.map(n => n.notional / totalNotional);

  // Portfolio historical simulation: sum(w_i * r_i,t)
  const minLen = Math.min(...Array.from(seriesBySym.values()).map(s => s.rets.length).filter(n => n>0), 60);
  const portRets: number[] = [];
  if (minLen > 5) {
    for (let t = 0; t < minLen; t++) {
      let r = 0;
      for (let i = 0; i < holdings.length; i++) {
        const rs = seriesBySym.get(holdings[i].symbol)!.rets;
        const val = rs[rs.length - minLen + t] ?? 0;
        const sign = holdings[i].side === "short" ? -1 : 1;
        r += weights[i] * sign * val;
      }
      portRets.push(r);
    }
  }

  const sorted = [...portRets].sort((a,b)=>a-b);
  const idx95 = Math.max(0, Math.floor(sorted.length * 0.05));
  const var95 = sorted.length ? -sorted[idx95] : 0;
  const tail = sorted.slice(0, Math.max(1, idx95));
  const cvar95 = tail.length ? -mean(tail) : 0;
  const vol = stdev(portRets);
  const exposureFactor = totalNotional / equity;

  // Correlation pairs.
  const pairs: { a: string; b: string; corr: number }[] = [];
  let maxCorr = 0;
  for (let i = 0; i < holdings.length; i++) {
    for (let j = i + 1; j < holdings.length; j++) {
      const ra = seriesBySym.get(holdings[i].symbol)?.rets ?? [];
      const rb = seriesBySym.get(holdings[j].symbol)?.rets ?? [];
      const c = pearson(ra, rb);
      pairs.push({ a: holdings[i].symbol, b: holdings[j].symbol, corr: c });
      if (Math.abs(c) > Math.abs(maxCorr)) maxCorr = c;
    }
  }

  // Per-asset open risk = |entry - stop| * qty ; heat = sum / equity.
  const perAsset = holdings.map(h => {
    const px = seriesBySym.get(h.symbol)?.closes.slice(-1)[0] ?? h.avgEntry;
    const stop = h.stopLoss && h.stopLoss > 0 ? h.stopLoss : h.avgEntry * 0.95;
    const risk = Math.max(0, Math.abs(px - stop) * h.qty);
    return { symbol: h.symbol, pct: (risk / equity) * 100 };
  });
  const portfolioHeatPct = perAsset.reduce((s,x)=>s+x.pct,0);

  // Risk score: composite of heat, VaR, |maxCorr|, exposure.
  const s = Math.min(100, Math.round(
    portfolioHeatPct * 8 + var95 * exposureFactor * 400 + Math.abs(maxCorr) * 25 + Math.min(exposureFactor, 2) * 10
  ));

  const advisories: string[] = [];
  if (portfolioHeatPct > 6) advisories.push(`Heat ${portfolioHeatPct.toFixed(1)}% — reduce open risk.`);
  if (var95 * exposureFactor * 100 > 5) advisories.push(`Daily 95% VaR ${(var95*exposureFactor*100).toFixed(1)}% of equity is high.`);
  if (Math.abs(maxCorr) > 0.8) advisories.push(`Two positions correlated at ${maxCorr.toFixed(2)} — diversify.`);
  if (exposureFactor > 1.2) advisories.push(`Gross exposure ${(exposureFactor*100).toFixed(0)}% of equity — leverage risk.`);
  if (advisories.length === 0) advisories.push("Portfolio risk is within all configured limits.");

  return {
    equity,
    openPositions: holdings.length,
    portfolioHeatPct,
    perAssetRiskPct: perAsset.sort((a,b)=>b.pct-a.pct),
    var95Pct: var95 * exposureFactor * 100,
    cvar95Pct: cvar95 * exposureFactor * 100,
    portfolioVolPct: vol * exposureFactor * 100,
    correlationMax: maxCorr,
    correlationPairs: pairs.sort((a,b)=>Math.abs(b.corr)-Math.abs(a.corr)).slice(0, 10),
    riskScore: s,
    advisories,
  };
}

// ---------- Dynamic position sizing ----------
export interface SizingInput {
  equity: number;
  symbol: string;
  entry: number;
  stopLoss: number;
  confidence: number;          // 0..1
  targetDailyVolPct: number;   // e.g. 1.5
  kellyFraction: number;       // e.g. 0.25
  maxRiskPerTradePct?: number; // default 1%
}
export interface SizingResult {
  qty: number;
  notional: number;
  riskUsd: number;
  riskPct: number;
  reasoning: string[];
  volDailyPct: number;
  kellyEdge: number;
}

export async function sizePosition(
  supabase: SupabaseClient | null,
  input: SizingInput,
): Promise<SizingResult> {
  const notes: string[] = [];
  const candles = await fetchCandles(supabase, input.symbol, "1d", 90).catch(() => []);
  const closes = candles.map(c => c.close);
  const rets = logReturns(closes);
  const volDaily = stdev(rets);
  const volPct = volDaily * 100;

  // Vol-target: target% / assetVol% * equity => notional
  const targetVol = Math.max(0.1, input.targetDailyVolPct);
  const volTargetNotional = volPct > 0
    ? (targetVol / volPct) * input.equity
    : 0.1 * input.equity;
  notes.push(`Vol-target: ${targetVol}% / ${volPct.toFixed(2)}% asset vol → $${volTargetNotional.toFixed(0)} notional.`);

  // Fractional Kelly: edge = 2*confidence - 1  (bounded)
  const edge = Math.max(0, Math.min(0.5, 2 * input.confidence - 1));
  const kellyPct = edge * input.kellyFraction;
  const kellyNotional = kellyPct * input.equity;
  notes.push(`Kelly: edge ${(edge*100).toFixed(0)}% × ${input.kellyFraction} = ${(kellyPct*100).toFixed(2)}% → $${kellyNotional.toFixed(0)}.`);

  // Fixed-fractional risk cap: risk / (entry - stop)
  const maxRiskPct = input.maxRiskPerTradePct ?? 1;
  const perShareRisk = Math.abs(input.entry - input.stopLoss);
  const riskCapUsd = (maxRiskPct / 100) * input.equity;
  const riskCapNotional = perShareRisk > 0 ? (riskCapUsd / perShareRisk) * input.entry : 0;
  notes.push(`Risk cap: ${maxRiskPct}% of equity ($${riskCapUsd.toFixed(0)}) / stop distance → $${riskCapNotional.toFixed(0)}.`);

  // Take the MIN of all three constraints.
  const notional = Math.max(0, Math.min(volTargetNotional, kellyNotional || volTargetNotional, riskCapNotional || volTargetNotional));
  const qty = input.entry > 0 ? notional / input.entry : 0;
  const riskUsd = qty * perShareRisk;
  notes.push(`Final: min of constraints → ${qty.toFixed(6)} @ $${input.entry} (risk $${riskUsd.toFixed(2)}).`);

  return {
    qty, notional, riskUsd,
    riskPct: (riskUsd / input.equity) * 100,
    reasoning: notes,
    volDailyPct: volPct,
    kellyEdge: edge,
  };
}
