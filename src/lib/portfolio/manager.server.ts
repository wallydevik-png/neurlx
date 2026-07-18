// AI Portfolio Manager. Combines account state, open positions, active
// signals and market-regime distribution into portfolio-level recommendations:
// what to increase, what to trim, what to avoid, and how much cash to keep.
// Correlation is estimated from recent close returns of the scanned universe.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandles } from "@/lib/marketdata/service.server";
import { scanMarket, type AiSignal } from "@/lib/trading/aiEngine.server";
import { listSupportedSymbols } from "@/lib/marketdata/service.server";

export type RiskProfile = "conservative" | "balanced" | "aggressive";

export interface AllocationTarget {
  symbol: string;
  action: "increase" | "reduce" | "hold" | "avoid";
  targetPct: number;      // recommended % of equity
  currentPct: number;     // current % of equity in this asset
  confidence: number;     // 0..1
  regimeLabel: string;
  reason: string;
}

export interface PortfolioRecommendation {
  equity: number;
  cashPct: number;
  targetCashPct: number;
  dominantRegime: string;
  regimeMix: Record<string, number>;
  targets: AllocationTarget[];
  avoid: { symbol: string; reason: string }[];
  correlationWarnings: string[];
  portfolioRiskScore: number; // 0..100
  reasoning: string;
}

const RISK_ENVELOPE: Record<RiskProfile, {
  maxPerAsset: number; minCash: number; minConfidence: number; maxAssets: number;
}> = {
  conservative: { maxPerAsset: 0.15, minCash: 0.4, minConfidence: 0.72, maxAssets: 4 },
  balanced:     { maxPerAsset: 0.25, minCash: 0.2, minConfidence: 0.62, maxAssets: 6 },
  aggressive:   { maxPerAsset: 0.4,  minCash: 0.05, minConfidence: 0.55, maxAssets: 8 },
};

// Pearson correlation of log returns; -1..+1.
function correlate(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const ra: number[] = []; const rb: number[] = [];
  for (let i = 1; i < n; i++) { ra.push(Math.log(a[i]/a[i-1])); rb.push(Math.log(b[i]/b[i-1])); }
  const ma = ra.reduce((s,x)=>s+x,0)/ra.length;
  const mb = rb.reduce((s,x)=>s+x,0)/rb.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { num += (ra[i]-ma)*(rb[i]-mb); da += (ra[i]-ma)**2; db += (rb[i]-mb)**2; }
  const denom = Math.sqrt(da*db);
  return denom === 0 ? 0 : num/denom;
}

export interface HoldingInput {
  symbol: string;
  qty: number;
  avgEntry: number;
  side: "long" | "short";
}

export async function buildPortfolioRecommendation(
  supabase: SupabaseClient | null,
  args: {
    cash: number;
    holdings: HoldingInput[];
    profile: RiskProfile;
    allowedAssets?: string[];
  },
): Promise<PortfolioRecommendation> {
  const env = RISK_ENVELOPE[args.profile];
  const universe = args.allowedAssets?.length ? args.allowedAssets : listSupportedSymbols();
  const signals = await scanMarket(supabase, universe);

  // Value holdings at current signal price (or entry as fallback)
  const priceBySym = new Map<string, number>(signals.map(s => [s.symbol, s.entry]));
  const holdingValue = args.holdings.reduce((sum, h) => {
    const px = priceBySym.get(h.symbol) ?? h.avgEntry;
    return sum + Math.abs(h.qty) * px;
  }, 0);
  const equity = args.cash + holdingValue;

  // Regime mix
  const regimeMix: Record<string, number> = {};
  for (const s of signals) regimeMix[s.regimeLabel] = (regimeMix[s.regimeLabel] ?? 0) + 1;
  const dominantRegime = Object.entries(regimeMix).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? "unknown";

  // Correlation warnings among tradable buys
  const buys = signals.filter(s => s.direction === "buy" && s.confidence >= env.minConfidence);
  const candles = await Promise.all(buys.slice(0, env.maxAssets).map(async s => ({
    sym: s.symbol,
    closes: (await fetchCandles(supabase, s.symbol, "1h", 120)).map(c => c.close),
  })));
  const correlationWarnings: string[] = [];
  for (let i = 0; i < candles.length; i++) {
    for (let j = i + 1; j < candles.length; j++) {
      const r = correlate(candles[i].closes, candles[j].closes);
      if (r > 0.85) correlationWarnings.push(`${candles[i].sym} ↔ ${candles[j].sym} highly correlated (ρ=${r.toFixed(2)}) — treat as one position.`);
    }
  }

  // Weight buys by confidence, cap by maxPerAsset and by max assets
  const cappedBuys = buys.slice(0, env.maxAssets);
  const weightSum = cappedBuys.reduce((s, x) => s + x.confidence, 0);
  const targetCashPct = Math.max(env.minCash, dominantRegime.includes("Extreme") ? 0.7 : env.minCash);
  const riskBudget = 1 - targetCashPct;

  const currentPctBySym = new Map<string, number>();
  for (const h of args.holdings) {
    const px = priceBySym.get(h.symbol) ?? h.avgEntry;
    const val = Math.abs(h.qty) * px;
    currentPctBySym.set(h.symbol, (currentPctBySym.get(h.symbol) ?? 0) + (equity > 0 ? val/equity : 0));
  }

  const targets: AllocationTarget[] = cappedBuys.map(s => {
    const raw = weightSum > 0 ? (s.confidence / weightSum) * riskBudget : 0;
    const targetPct = Math.min(env.maxPerAsset, raw);
    const currentPct = currentPctBySym.get(s.symbol) ?? 0;
    const action: AllocationTarget["action"] =
      targetPct > currentPct + 0.01 ? "increase" :
      targetPct < currentPct - 0.01 ? "reduce" : "hold";
    return {
      symbol: s.symbol, action, targetPct, currentPct,
      confidence: s.confidence, regimeLabel: s.regimeLabel,
      reason: `${s.regimeLabel}. ${s.contributions.filter(c=>c.weight!==0).slice(0,2).map(c=>c.indicator+" "+c.signal).join(", ") || "Weak driver mix."}`,
    };
  });

  // Anything currently held but not in target list → reduce to 0
  for (const [sym, pct] of currentPctBySym) {
    if (!targets.some(t => t.symbol === sym)) {
      const sig = signals.find(s => s.symbol === sym);
      targets.push({
        symbol: sym, action: "reduce", targetPct: 0, currentPct: pct,
        confidence: sig?.confidence ?? 0, regimeLabel: sig?.regimeLabel ?? "unknown",
        reason: sig ? `${sig.regimeLabel}. Signal now ${sig.direction.toUpperCase()} @ ${(sig.confidence*100).toFixed(0)}%.` : "No longer meets conviction threshold.",
      });
    }
  }

  const avoid = signals
    .filter(s => (s.direction === "wait" && (s.riskLevel === "high" || s.regime === "extreme_risk")) || s.regime === "extreme_risk")
    .slice(0, 6)
    .map(s => ({ symbol: s.symbol, reason: `${s.regimeLabel} — ${s.riskFactors[0] ?? "elevated risk"}` }));

  // Portfolio risk score
  const exposurePct = equity > 0 ? holdingValue / equity : 0;
  const regimeRisk = dominantRegime.includes("Extreme") ? 40 : dominantRegime.includes("High") ? 25 : dominantRegime.includes("Ranging") ? 12 : 8;
  const corrRisk = Math.min(30, correlationWarnings.length * 10);
  const concentration = Math.max(0, ...Array.from(currentPctBySym.values())) * 100 * 0.5;
  const portfolioRiskScore = Math.min(100, Math.round(regimeRisk + corrRisk + concentration + exposurePct*20));

  const reasoning =
    `Regime is dominantly ${dominantRegime} across ${signals.length} scanned assets. ` +
    `Under a ${args.profile} profile the AI targets ${(targetCashPct*100).toFixed(0)}% cash, ` +
    `spreads the remaining ${(riskBudget*100).toFixed(0)}% across ${cappedBuys.length} conviction-weighted positions ` +
    `(cap ${(env.maxPerAsset*100).toFixed(0)}%/asset), and flags ${correlationWarnings.length} correlation cluster${correlationWarnings.length===1?'':'s'}. ` +
    `Past performance does not guarantee future results.`;

  return {
    equity, cashPct: equity > 0 ? args.cash/equity : 1,
    targetCashPct, dominantRegime, regimeMix,
    targets: targets.sort((a,b) => b.targetPct - a.targetPct),
    avoid, correlationWarnings, portfolioRiskScore, reasoning,
  };
}

export type { AiSignal };
