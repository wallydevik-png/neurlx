// AI Portfolio Manager. Combines account state, open positions, active
// signals and market-regime distribution into portfolio-level recommendations:
// what to increase, what to trim, what to avoid, and how much cash to keep.
// Correlation is estimated from recent close returns of the scanned universe.
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandles } from "@/lib/marketdata/service.server";
import { scanMarket, type AiSignal } from "@/lib/trading/aiEngine.server";

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
  userId?: string | null,
): Promise<PortfolioRecommendation> {
  const env = RISK_ENVELOPE[args.profile];
  const { listTradableSymbols } = await import("@/lib/marketdata/service.server");
  const universe = args.allowedAssets?.length ? args.allowedAssets : await listTradableSymbols(supabase, userId);
  const signals = await scanMarket(supabase, universe, userId);

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

  // Correlation warnings among tradable directional ideas (long AND short).
  const buys = signals.filter(s => s.direction !== "wait" && s.confidence >= env.minConfidence);
  const candles = await Promise.all(buys.slice(0, env.maxAssets).map(async s => ({
    sym: s.symbol,
    closes: (await fetchCandles(supabase, s.symbol, "1h", 120, userId)).map(c => c.close),
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

// ---------------------------------------------------------------------
// Portfolio Manager AI — sits above every individual strategy/signal and
// above the per-trade Risk Engine. Tracks portfolio-wide health, assigns a
// trading "mode" (aggressive/normal/defensive/paused), scores each proposed
// trade against the whole book (not just in isolation), and grades what
// actually happened afterward so the loop can self-calibrate. This was
// previously called throughout the app (autonomous cycle, dashboard) but
// never implemented — every call site threw "not a function".
// ---------------------------------------------------------------------
import { sectorOf, assumedCorrelation, DEFAULT_SECTOR_LIMITS, type Sector } from "./sectors";

export interface PortfolioHealth {
  healthScore: number;
  heat: number;
  riskConcentration: number;
  capitalUtilization: number;
  correlationScore: number;
  volatility: number;
  diversificationScore: number;
  recoveryFactor: number;
  expectedMonthlyReturn: number;
  worstCaseProjection: number;
  expectedDrawdown: number;
  notes: string[];
  sectorExposure: Record<string, number>;
}

export interface PortfolioConstraints {
  minScore: number;
  minConfidence: number;
  maxOpenTrades: number | null;
  sizeMultiplier: number;
}

export interface OpenPositionSummary {
  symbol: string;
  side: string;
  riskPct: number;
  notional: number;
  sector: Sector;
}

export interface PortfolioContext {
  equity: number;
  mode: "aggressive" | "normal" | "defensive" | "paused";
  health: PortfolioHealth;
  open: OpenPositionSummary[];
  constraints: PortfolioConstraints;
  drawdownPct: number; // fraction, e.g. 0.05 = 5% — dashboard multiplies by 100
  settings: Record<string, unknown>;
}

/**
 * Builds the shared portfolio-wide snapshot everything else in this module
 * reads from: equity, open-book composition, correlation/sector exposure,
 * a rolled-up health score, the resulting trading "mode", and the
 * constraints (min score/confidence, max open trades, size multiplier)
 * that mode implies.
 */
export async function loadPortfolioContext(
  supabase: SupabaseClient, userId: string, liveEquityOverride?: number, connectionId?: string,
): Promise<PortfolioContext> {
  const [{ data: settingsRow }, { data: account }, { data: open }, { data: recentClosed }] = await Promise.all([
    supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("paper_accounts").select("equity, cash_balance").eq("user_id", userId).maybeSingle(),
    supabase.from("positions").select("symbol, side, qty, avg_entry, stop_loss")
      .eq("user_id", userId).eq("status", "open"),
    supabase.from("positions").select("realized_pnl, closed_at").eq("user_id", userId).eq("status", "closed")
      .order("closed_at", { ascending: false }).limit(30),
  ]);
  const settings = (settingsRow ?? {}) as Record<string, unknown>;
  const equity = Number(
    liveEquityOverride && liveEquityOverride > 0 ? liveEquityOverride : account?.equity ?? account?.cash_balance ?? 0,
  );

  const openPositions: OpenPositionSummary[] = (open ?? []).map(p => {
    const notional = Math.abs(Number(p.qty)) * Number(p.avg_entry);
    const riskPct = p.stop_loss && equity > 0
      ? (Math.abs(Number(p.avg_entry) - Number(p.stop_loss)) * Math.abs(Number(p.qty)) / equity) * 100
      : 0;
    return { symbol: p.symbol as string, side: p.side as string, riskPct, notional, sector: sectorOf(p.symbol as string) };
  });

  const sectorExposure: Record<string, number> = {};
  if (equity > 0) {
    for (const p of openPositions) {
      sectorExposure[p.sector] = (sectorExposure[p.sector] ?? 0) + (p.notional / equity) * 100;
    }
  }

  let correlationScore = 0;
  if (openPositions.length > 1) {
    let sum = 0, n = 0;
    for (let i = 0; i < openPositions.length; i++) {
      for (let j = i + 1; j < openPositions.length; j++) {
        sum += assumedCorrelation(openPositions[i].symbol, openPositions[j].symbol);
        n++;
      }
    }
    correlationScore = n > 0 ? (sum / n) * 100 : 0;
  }

  const totalRiskPct = openPositions.reduce((s, p) => s + p.riskPct, 0);
  const totalNotionalPct = equity > 0 ? (openPositions.reduce((s, p) => s + p.notional, 0) / equity) * 100 : 0;
  const maxSectorExposure = Math.max(0, ...Object.values(sectorExposure));
  const maxSinglePositionRisk = Math.max(0, ...openPositions.map(p => p.riskPct));

  const pnls = (recentClosed ?? []).map(r => Number(r.realized_pnl ?? 0));
  const totalRecentPnl = pnls.reduce((s, x) => s + x, 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const winRate = pnls.length > 0 ? wins.length / pnls.length : 0.5;
  const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, x) => s + x, 0) / losses.length) : 0;
  const mean = pnls.length ? totalRecentPnl / pnls.length : 0;
  const variance = pnls.length > 1 ? pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (pnls.length - 1) : 0;
  const stdev = Math.sqrt(variance);
  const volatility = equity > 0 ? Math.min(100, (stdev / equity) * 100 * 5) : 0;

  // High-water mark / drawdown — same approach as the per-trade risk policy.
  let storedHw = Number(settings["equity_high_water"] ?? 0);
  if (connectionId) {
    const { data: connection } = await supabase.from("exchange_connections")
      .select("live_equity_high_water").eq("id", connectionId).eq("user_id", userId).maybeSingle();
    storedHw = Number(connection?.live_equity_high_water ?? 0);
  }
  const highWater = Math.max(storedHw, equity);
  if (equity > storedHw && equity > 0) {
    if (connectionId) {
      await supabase.from("exchange_connections").update({ live_equity_high_water: equity })
        .eq("id", connectionId).eq("user_id", userId);
    } else {
      await supabase.from("automation_settings").update({ equity_high_water: equity }).eq("user_id", userId);
    }
  }
  const drawdownPct = highWater > 0 ? Math.max(0, (highWater - equity) / highWater) : 0;

  let peak = 0, running = 0, maxDD = 0;
  for (const p of pnls.slice().reverse()) {
    running += p;
    peak = Math.max(peak, running);
    maxDD = Math.max(maxDD, peak - running);
  }
  const recoveryFactor = maxDD > 0
    ? Math.min(100, Math.max(0, (totalRecentPnl / maxDD) * 25 + 50))
    : (totalRecentPnl >= 0 ? 90 : 40);

  const diversificationScore = openPositions.length === 0
    ? 100 : Math.max(0, 100 - maxSectorExposure - Math.max(0, correlationScore - 30));

  const heat = Math.min(100, totalRiskPct * 8);
  const riskConcentration = Math.min(100, Math.max(maxSinglePositionRisk * 10, maxSectorExposure));
  const capitalUtilization = Math.min(100, totalNotionalPct);

  const notes: string[] = [];
  const maxCorrelatedRiskPct = Number(settings["max_correlated_risk_pct"] ?? 2);
  const maxAccountDD = Number(settings["max_account_drawdown_pct"] ?? 15);
  if (totalRiskPct > maxCorrelatedRiskPct * 2) notes.push("Total open risk is elevated relative to your correlated-risk limit.");
  if (correlationScore > 70) notes.push("Open positions are highly correlated — treat them as one concentrated bet.");
  if (maxSectorExposure > 35) notes.push("One sector accounts for a large share of exposure.");
  if (drawdownPct * 100 > maxAccountDD * 0.6) notes.push("Approaching your max account drawdown limit — sizing is being scaled down.");
  if (winRate < 0.35 && pnls.length >= 10) notes.push("Recent win rate is low — consider reviewing strategy quality before scaling up.");

  let healthScore = 100
    - heat * 0.25
    - riskConcentration * 0.2
    - Math.max(0, correlationScore - 20) * 0.25
    - volatility * 0.15
    - drawdownPct * 100 * 0.5;
  healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

  const expectedMonthlyReturn = +((winRate * avgWin - (1 - winRate) * avgLoss) * 20).toFixed(2);
  const worstCaseProjection = +(-(Math.max(avgLoss, stdev) * 5)).toFixed(2);
  const expectedDrawdown = +Math.max(drawdownPct * 100, volatility * 0.6).toFixed(2);

  const killSwitch = settings["kill_switch_active"] === true;
  let mode: PortfolioContext["mode"];
  if (killSwitch || drawdownPct * 100 >= maxAccountDD) mode = "paused";
  else if (healthScore < 45 || drawdownPct * 100 >= maxAccountDD * 0.7) mode = "defensive";
  else if (healthScore >= 75 && settings["aggressive_mode_enabled"] !== false && drawdownPct < 0.03) mode = "aggressive";
  else mode = "normal";

  const pmMinScore = Number(settings["pm_min_score"] ?? 75);
  // The portfolio manager used to enforce its own hardcoded confidence floors,
  // which silently overrode whatever the user set on the Autonomous page. The
  // user's configured floor is now authoritative: the PM never demands more
  // confidence than the user asked for (except in defensive mode, where it adds
  // a small safety margin, and paused, which blocks everything).
  const userFloor = Math.min(0.99, Math.max(0.2, Number(settings["autonomous_min_confidence"] ?? 0.65)));
  const constraintsByMode: Record<PortfolioContext["mode"], PortfolioConstraints> = {
    aggressive: { minScore: Math.max(55, pmMinScore - 15), minConfidence: userFloor, maxOpenTrades: null, sizeMultiplier: 1.25 },
    normal: { minScore: pmMinScore, minConfidence: userFloor, maxOpenTrades: null, sizeMultiplier: 1 },
    defensive: { minScore: Math.min(95, pmMinScore + 15), minConfidence: Math.min(0.95, userFloor + 0.1), maxOpenTrades: Math.max(1, openPositions.length), sizeMultiplier: 0.5 },
    paused: { minScore: 101, minConfidence: 1.01, maxOpenTrades: 0, sizeMultiplier: 0 },
  };

  return {
    equity, mode,
    health: {
      healthScore, heat, riskConcentration, capitalUtilization, correlationScore,
      volatility, diversificationScore, recoveryFactor,
      expectedMonthlyReturn, worstCaseProjection, expectedDrawdown,
      notes, sectorExposure,
    },
    open: openPositions,
    constraints: constraintsByMode[mode],
    drawdownPct,
    settings,
  };
}

/** Writes one row of the current health snapshot for the dashboard's
 *  history/trend view. */
export async function snapshotHealth(
  supabase: SupabaseClient, userId: string, ctx: PortfolioContext,
): Promise<void> {
  await supabase.from("portfolio_health_snapshots").insert({
    user_id: userId,
    health_score: ctx.health.healthScore,
    heat: ctx.health.heat,
    risk_concentration: ctx.health.riskConcentration,
    capital_utilization: ctx.health.capitalUtilization,
    correlation_score: ctx.health.correlationScore,
    volatility: ctx.health.volatility,
    expected_drawdown: ctx.health.expectedDrawdown,
    diversification_score: ctx.health.diversificationScore,
    recovery_factor: ctx.health.recoveryFactor,
    expected_monthly_return: ctx.health.expectedMonthlyReturn,
    worst_case_projection: ctx.health.worstCaseProjection,
    portfolio_mode: ctx.mode,
    sector_exposure: ctx.health.sectorExposure,
    detail: { notes: ctx.health.notes, openCount: ctx.open.length, equity: ctx.equity },
  });
}

export interface TradeCandidate {
  signalId: string;
  strategyId: string | null;
  symbol: string;
  side: "buy" | "sell";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number; // 0..1
  /**
   * Live regime classification measured by the entry gate in THIS cycle.
   * Preferred over the stored snapshot: the snapshot is written after the
   * fact, so on a fresh symbol it was absent and the score silently fell back
   * to a flat 60 that no real setup could ever beat.
   */
  regimeNow?: { regime: string; tradable: boolean; confidence: number } | null;
}

export interface PortfolioVerdict {
  approved: boolean;
  rejectReason: string | null;
  riskPct: number;       // % of equity to risk on this trade, ready to size with
  allocationPct: number; // reported allocation weight in percent (same basis as riskPct)
  allocation: number;    // same value as a 0..1 fraction, for display/logging
  score: number;         // 0..100
  components: Record<string, number>;
  notes: string[];
  regime: string | null;
  mode: string;
  healthScore: number;
}

/**
 * Scores a trade idea that has already passed the AI Committee and entry
 * filters — not "is this a good trade" (already decided), but "is this a
 * good use of the portfolio's remaining risk budget right now," given
 * current exposure, correlation with the existing book, sector limits, and
 * the trading mode loadPortfolioContext already assigned.
 */
export async function evaluateOpportunity(
  supabase: SupabaseClient, userId: string, ctx: PortfolioContext, candidate: TradeCandidate,
): Promise<PortfolioVerdict> {
  const notes: string[] = [];
  const sector = sectorOf(candidate.symbol);

  const risk = Math.abs(candidate.entry - candidate.stopLoss);
  const reward = Math.abs(candidate.takeProfit - candidate.entry);
  const rr = risk > 0 ? reward / risk : 0;
  const expectancyScore = Math.min(100, rr * 25);

  const confidenceScore = candidate.confidence * 100;

  let regime: string | null = null;
  let regimeScore = 60;
  if (candidate.regimeNow) {
    regime = candidate.regimeNow.regime;
    regimeScore = candidate.regimeNow.tradable
      ? 60 + Math.max(0, Math.min(1, candidate.regimeNow.confidence)) * 40
      : 25;
  } else {
    try {
      const { data: recentRegime } = await supabase.from("market_regime_snapshots")
        .select("regime, tradable, confidence").eq("user_id", userId).eq("symbol", candidate.symbol)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (recentRegime) {
        regime = recentRegime.regime as string;
        regimeScore = recentRegime.tradable ? 60 + Number(recentRegime.confidence) * 40 : 25;
      }
    } catch { /* best-effort — regime data is a scoring input, not a hard requirement */ }
  }

  const maxCorr = ctx.open.length
    ? Math.max(...ctx.open.map(o => assumedCorrelation(candidate.symbol, o.symbol)))
    : 0;
  const correlationScore = Math.max(0, 100 - maxCorr * 100);
  if (maxCorr > 0.8) notes.push(`Highly correlated with an existing open position (ρ≈${maxCorr.toFixed(2)}).`);

  const sectorLimits = { ...DEFAULT_SECTOR_LIMITS, ...((ctx.settings["sector_limits"] as Record<string, number> | undefined) ?? {}) };
  const sectorLimit = sectorLimits[sector] ?? 20;
  const currentSectorExposure = ctx.health.sectorExposure[sector] ?? 0;
  const exposureHeadroomPct = Math.max(0, sectorLimit - currentSectorExposure);
  const exposureScore = sectorLimit > 0 ? Math.min(100, (exposureHeadroomPct / sectorLimit) * 100) : 50;
  const sectorBreached = currentSectorExposure >= sectorLimit;
  if (sectorBreached) notes.push(`${sector} sector already at or above its ${sectorLimit}% exposure limit.`);

  // Cost/liquidity proxy — majors score higher than long-tail alts/exotics.
  const base = candidate.symbol.split(/[-/]/)[0]?.toUpperCase() ?? candidate.symbol;
  const costScore = ["BTC", "ETH", "EUR", "GBP", "USD", "XAU"].includes(base) ? 80 : 60;

  // Strategy quality. Prefer the strategy's own score; when it has none yet,
  // fall back to its measured shadow/paper record instead of a flat 60 that
  // is unreachable-by-design in defensive mode.
  let strategyScore = 60;
  if (candidate.strategyId) {
    const { data: strat } = await supabase.from("strategies").select("score")
      .eq("id", candidate.strategyId).maybeSingle();
    if (strat?.score != null) strategyScore = Number(strat.score);
  }
  if (strategyScore === 60) {
    try {
      let q = supabase.from("shadow_trades")
        .select("pnl, strategy_id, symbol")
        .eq("user_id", userId).eq("status", "closed")
        .order("created_at", { ascending: false }).limit(40);
      q = candidate.strategyId
        ? q.eq("strategy_id", candidate.strategyId)
        : q.eq("symbol", candidate.symbol);
      const { data: shadow } = await q;
      const pnls = (shadow ?? []).map(s => Number((s as { pnl: number | null }).pnl ?? 0));
      if (pnls.length >= 5) {
        const wins = pnls.filter(p => p > 0).length;
        const winRate = wins / pnls.length;
        // 0% win rate -> 30, 50% -> 60, 100% -> 90. Evidence-scaled, not flat.
        strategyScore = 30 + winRate * 60;
        notes.push(`Strategy record: ${wins}/${pnls.length} shadow wins (${(winRate * 100).toFixed(0)}%).`);
      }
    } catch { /* best-effort — evidence is an input, not a requirement */ }
  }

  const components: Record<string, number> = {
    expectancy: +expectancyScore.toFixed(1),
    confidence: +confidenceScore.toFixed(1),
    regime: +regimeScore.toFixed(1),
    correlation: +correlationScore.toFixed(1),
    exposure: +exposureScore.toFixed(1),
    cost: +costScore.toFixed(1),
    strategy: +strategyScore.toFixed(1),
  };
  const score = Math.round(
    components.expectancy * 0.2 + components.confidence * 0.15 + components.regime * 0.15 +
    components.correlation * 0.15 + components.exposure * 0.15 + components.cost * 0.1 +
    components.strategy * 0.1,
  );

  const maxOpenReached = ctx.constraints.maxOpenTrades != null && ctx.open.length >= ctx.constraints.maxOpenTrades;

  let approved = true;
  let rejectReason: string | null = null;
  if (ctx.mode === "paused") { approved = false; rejectReason = "portfolio_paused"; }
  else if (maxOpenReached) { approved = false; rejectReason = "max_open_trades_reached"; }
  else if (sectorBreached) { approved = false; rejectReason = "sector_limit_breached"; }
  else if (candidate.confidence < ctx.constraints.minConfidence) { approved = false; rejectReason = "below_pm_min_confidence"; }
  else if (score < ctx.constraints.minScore) { approved = false; rejectReason = "below_pm_min_score"; }

  const baseRiskPct = Number(ctx.settings["risk_per_trade_pct"] ?? 0.005) * 100; // stored as a fraction (0.005 = 0.5%)
  const scaling = 0.5 + 0.5 * (score / 100);
  const capRiskPct = Number(ctx.settings["max_correlated_risk_pct"] ?? 2);
  const riskPct = approved
    ? Math.min(capRiskPct, +(baseRiskPct * ctx.constraints.sizeMultiplier * scaling).toFixed(3))
    : 0;

  return {
    approved, rejectReason, riskPct, allocationPct: riskPct, allocation: riskPct / 100,
    score, components, notes, regime, mode: ctx.mode, healthScore: ctx.health.healthScore,
  };
}

/** Logs every Portfolio Manager verdict (approved or not) for audit/analytics. */
export async function recordDecision(
  supabase: SupabaseClient, userId: string, candidate: TradeCandidate, verdict: PortfolioVerdict,
): Promise<void> {
  await supabase.from("portfolio_decisions").insert({
    user_id: userId,
    signal_id: candidate.signalId,
    strategy_id: candidate.strategyId,
    symbol: candidate.symbol,
    side: candidate.side,
    score: verdict.score,
    allocation_pct: verdict.allocationPct,
    risk_pct: verdict.riskPct,
    approved: verdict.approved,
    reject_reason: verdict.rejectReason,
    stage: "portfolio_manager",
    portfolio_mode: verdict.mode,
    regime: verdict.regime,
    health_score: verdict.healthScore,
    components: verdict.components,
    notes: verdict.notes,
  });
}

/**
 * Grades trades after they close — a feedback/calibration loop, not a
 * prediction. Scores execution, timing, risk discipline, and confidence
 * calibration from what actually happened, and writes a letter grade both
 * to trade_quality_scores (detail) and positions.trade_grade (summary).
 */
export async function gradeClosedTrades(
  supabase: SupabaseClient, userId: string,
): Promise<{ graded: number }> {
  const { data: closed } = await supabase.from("positions")
    .select("id, symbol, side, avg_entry, stop_loss, exit_price, exit_reason, strategy_id, ai_confidence")
    .eq("user_id", userId).eq("status", "closed").is("trade_grade", null)
    .order("closed_at", { ascending: false }).limit(50);
  if (!closed?.length) return { graded: 0 };

  let graded = 0;
  for (const p of closed) {
    const entry = Number(p.avg_entry);
    const exit = p.exit_price != null ? Number(p.exit_price) : entry;
    const stop = p.stop_loss != null ? Number(p.stop_loss) : null;
    const dir = p.side === "long" ? 1 : -1;
    const plannedRisk = stop != null ? Math.abs(entry - stop) : null;
    const realizedMove = (exit - entry) * dir;
    const realizedR = plannedRisk && plannedRisk > 0 ? realizedMove / plannedRisk : 0;

    const executionQuality = p.exit_reason === "take_profit" ? 90
      : p.exit_reason === "stop_loss" ? 60
      : p.exit_reason === "kill_switch" ? 40 : 65;
    const entryTiming = Math.max(20, Math.min(100, 60 + realizedR * 10));
    const exitTiming = p.exit_reason === "take_profit" ? 85 : p.exit_reason === "manual" ? 55 : 70;
    const riskQuality = plannedRisk ? (realizedR < -1.3 ? 40 : 80) : 60; // meaningfully worse than planned stop = slippage/gap flag
    const sizeQuality = 70; // no equity-at-open snapshot captured yet to score this precisely
    const psychology = (p.exit_reason === "manual" && realizedR < 0 && realizedR > -0.5) ? 45 : 70;
    const aiConfidence = p.ai_confidence != null ? Number(p.ai_confidence) * 100 : 60;

    const overall = Math.round(
      executionQuality * 0.25 + entryTiming * 0.15 + exitTiming * 0.15 +
      riskQuality * 0.2 + sizeQuality * 0.1 + psychology * 0.1 + aiConfidence * 0.05,
    );
    const grade = overall >= 85 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : overall >= 40 ? "D" : "F";

    await supabase.from("trade_quality_scores").upsert({
      user_id: userId, position_id: p.id, strategy_id: p.strategy_id, symbol: p.symbol,
      execution_quality: executionQuality, entry_timing: entryTiming, exit_timing: exitTiming,
      risk_quality: riskQuality, size_quality: sizeQuality, psychology, ai_confidence: aiConfidence,
      overall, grade, detail: { realizedR: +realizedR.toFixed(2), exitReason: p.exit_reason },
    }, { onConflict: "position_id" });
    await supabase.from("positions").update({ trade_grade: grade }).eq("id", p.id);
    graded++;
  }
  return { graded };
}

/**
 * Tests a candidate capital-allocation model "in shadow" against recent
 * trade history — computed and stored, never applied live — so it can be
 * validated before anyone considers promoting it. Only re-runs once there's
 * a meaningful amount of new evidence since the last version.
 */
export async function runCapitalEngine(
  supabase: SupabaseClient, userId: string,
): Promise<{ ran: boolean; version?: number }> {
  const { data: closed } = await supabase.from("positions")
    .select("realized_pnl, avg_entry, stop_loss, take_profit, duration_seconds, strategy_id")
    .eq("user_id", userId).eq("status", "closed").order("closed_at", { ascending: false }).limit(200);
  const trades = closed ?? [];
  if (trades.length < 20) return { ran: false };

  const { data: latest } = await supabase.from("capital_engine_params")
    .select("version, trades_evaluated").eq("user_id", userId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  const lastEvaluated = Number(latest?.trades_evaluated ?? 0);
  if (trades.length - lastEvaluated < 15) return { ran: false };

  const pnls = trades.map(t => Number(t.realized_pnl ?? 0));
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const winRate = pnls.length ? wins.length / pnls.length : 0;
  const avgWin = wins.length ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, x) => s + x, 0) / losses.length) : 1;

  const rMultiples: number[] = [];
  const durations: number[] = [];
  for (const t of trades) {
    const entry = Number(t.avg_entry);
    const stop = t.stop_loss != null ? Number(t.stop_loss) : null;
    const tp = t.take_profit != null ? Number(t.take_profit) : null;
    if (stop != null && tp != null && Math.abs(entry - stop) > 0) {
      rMultiples.push(Math.abs(tp - entry) / Math.abs(entry - stop));
    }
    if (t.duration_seconds != null) durations.push(Number(t.duration_seconds));
  }
  const avgTpR = rMultiples.length ? rMultiples.reduce((s, x) => s + x, 0) / rMultiples.length : 2;
  const avgHoldingMinutes = durations.length ? (durations.reduce((s, x) => s + x, 0) / durations.length) / 60 : 240;

  // Kelly-ish fraction, heavily capped — a shadow proposal errs cautious.
  const b = avgLoss > 0 ? avgWin / avgLoss : 1;
  const kelly = b > 0 ? winRate - (1 - winRate) / b : 0;
  const optimalAllocationPct = Math.max(0.25, Math.min(2, kelly * 100 * 0.5));

  const strategyPnl = new Map<string, number>();
  for (const t of trades) {
    const k = (t.strategy_id as string | null) ?? "unassigned";
    strategyPnl.set(k, (strategyPnl.get(k) ?? 0) + Number(t.realized_pnl ?? 0));
  }
  const totalPositive = [...strategyPnl.values()].filter(v => v > 0).reduce((s, x) => s + x, 0);
  const strategyWeights: Record<string, number> = {};
  for (const [k, v] of strategyPnl) strategyWeights[k] = v > 0 && totalPositive > 0 ? +(v / totalPositive).toFixed(3) : 0;

  const version = Number(latest?.version ?? 0) + 1;
  await supabase.from("capital_engine_params").insert({
    user_id: userId, version, status: "shadow", trades_evaluated: trades.length,
    optimal_allocation_pct: +optimalAllocationPct.toFixed(3),
    optimal_stop_atr_mult: 1.5,
    optimal_tp_r_multiple: +avgTpR.toFixed(2),
    optimal_holding_minutes: Math.round(avgHoldingMinutes),
    optimal_trailing_pct: 0.015,
    strategy_weights: strategyWeights,
    metrics: { winRate: +winRate.toFixed(3), avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2), sampleSize: trades.length },
  });
  return { ran: true, version };
}

/** Stores a macro-regime classification snapshot for the regime-history view. */
export async function recordRegime(
  supabase: SupabaseClient, userId: string, report: {
    symbol: string; regime: string; label: string; confidence: number; tradable: boolean;
    bias?: string; volatilityPct?: number; trendQuality?: number; volumeRatio?: number;
    adx?: number | null; at?: number;
  },
): Promise<void> {
  await supabase.from("market_regime_snapshots").insert({
    user_id: userId, symbol: report.symbol, regime: report.regime, label: report.label,
    confidence: report.confidence, tradable: report.tradable,
    metrics: {
      bias: report.bias, volatilityPct: report.volatilityPct, trendQuality: report.trendQuality,
      volumeRatio: report.volumeRatio, adx: report.adx, at: report.at,
    },
  });
}
