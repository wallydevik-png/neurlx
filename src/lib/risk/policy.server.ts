// Institutional capital-protection policy engine.
//
// Owns everything that decides HOW MUCH may be risked and WHETHER trading is
// permitted at all right now:
//   - dynamic per-trade risk (0.25% .. 1% of equity)
//   - daily 3% / weekly 6% / overall 15% drawdown circuit breakers
//   - capital-preservation mode below -10% from equity high-water
//   - consecutive-loss recovery pauses (3 losses -> 1h, 5 losses -> 24h)
//   - equity-tiered max concurrent positions
//   - correlated-cluster risk budget (default 2% of equity combined)
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCandles } from "@/lib/marketdata/service.server";
import { correlation } from "@/lib/analysis/institutional";

export const RISK_FLOOR = 0.0025;
export const RISK_CEILING = 0.01;

export interface PolicySnapshot {
  equity: number;
  highWater: number;
  dailyPnl: number;
  weeklyPnl: number;
  dailyDrawdownPct: number;
  weeklyDrawdownPct: number;
  totalDrawdownPct: number;
  capitalPreservation: boolean;
  consecutiveLosses: number;
  recoveryPauseUntil: string | null;
  openPositions: number;
  maxOpenPositions: number;
  tradingAllowed: boolean;
  blocks: string[];
  limits: {
    dailyPct: number; weeklyPct: number; accountPct: number;
    maxCorrelatedRiskPct: number; baseRiskPct: number;
  };
}

export function maxPositionsForEquity(equity: number): number {
  if (equity < 1000) return 1;
  if (equity < 5000) return 2;
  if (equity < 10000) return 3;
  if (equity < 50000) return 5;
  return 8;
}

function startOfUtcDay(d = new Date()) {
  const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x;
}
function startOfUtcWeek(d = new Date()) {
  const x = startOfUtcDay(d);
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}

/**
 * Reads settings + realized P&L and produces the current trading permission
 * state. `equity` should be the live broker equity when available.
 */
export async function loadPolicy(
  supabase: SupabaseClient,
  userId: string,
  equityInput?: number,
): Promise<PolicySnapshot> {
  const { data: settings } = await supabase
    .from("automation_settings").select("*").eq("user_id", userId).maybeSingle();
  const { data: account } = await supabase
    .from("paper_accounts").select("equity, cash_balance").eq("user_id", userId).maybeSingle();

  const equity = Number(
    equityInput && equityInput > 0 ? equityInput : account?.equity ?? account?.cash_balance ?? 0,
  );

  const dayStart = startOfUtcDay().toISOString();
  const weekStart = startOfUtcWeek().toISOString();

  const [{ data: dayTrades }, { data: weekTrades }, { data: recent }, { data: open }] = await Promise.all([
    supabase.from("positions").select("realized_pnl").eq("user_id", userId)
      .eq("status", "closed").gte("closed_at", dayStart),
    supabase.from("positions").select("realized_pnl").eq("user_id", userId)
      .eq("status", "closed").gte("closed_at", weekStart),
    supabase.from("positions").select("realized_pnl, closed_at").eq("user_id", userId)
      .eq("status", "closed").order("closed_at", { ascending: false }).limit(10),
    supabase.from("positions").select("id").eq("user_id", userId).eq("status", "open"),
  ]);

  const sum = (rows: { realized_pnl: number | null }[] | null) =>
    (rows ?? []).reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);

  const dailyPnl = sum(dayTrades);
  const weeklyPnl = sum(weekTrades);

  const storedHw = Number(settings?.equity_high_water ?? 0);
  const highWater = Math.max(storedHw, equity);
  if (equity > storedHw && equity > 0) {
    await supabase.from("automation_settings")
      .update({ equity_high_water: equity }).eq("user_id", userId);
  }

  const dailyBase = equity - dailyPnl;
  const weeklyBase = equity - weeklyPnl;
  const dailyDrawdownPct = dailyBase > 0 && dailyPnl < 0 ? (-dailyPnl / dailyBase) * 100 : 0;
  const weeklyDrawdownPct = weeklyBase > 0 && weeklyPnl < 0 ? (-weeklyPnl / weeklyBase) * 100 : 0;
  const totalDrawdownPct = highWater > 0 ? Math.max(0, ((highWater - equity) / highWater) * 100) : 0;

  // Consecutive losses from the most recent closed trades.
  let consecutiveLosses = 0;
  for (const t of recent ?? []) {
    if (Number(t.realized_pnl ?? 0) < 0) consecutiveLosses++;
    else break;
  }

  const limits = {
    dailyPct: Number(settings?.max_daily_drawdown_pct ?? 3),
    weeklyPct: Number(settings?.max_weekly_drawdown_pct ?? 6),
    accountPct: Number(settings?.max_account_drawdown_pct ?? 15),
    maxCorrelatedRiskPct: Number(settings?.max_correlated_risk_pct ?? 2),
    baseRiskPct: Number(settings?.risk_per_trade_pct ?? 0.005),
  };

  const blocks: string[] = [];
  if (settings?.kill_switch_active) blocks.push("Emergency kill switch is active.");
  if (dailyDrawdownPct >= limits.dailyPct) {
    blocks.push(`Daily drawdown ${dailyDrawdownPct.toFixed(2)}% reached the ${limits.dailyPct}% limit — trading halted until tomorrow.`);
  }
  if (weeklyDrawdownPct >= limits.weeklyPct) {
    blocks.push(`Weekly drawdown ${weeklyDrawdownPct.toFixed(2)}% reached the ${limits.weeklyPct}% limit — trading halted for the week.`);
  }
  if (totalDrawdownPct >= limits.accountPct) {
    blocks.push(`Account drawdown ${totalDrawdownPct.toFixed(2)}% reached the ${limits.accountPct}% hard limit — autonomous trading disabled.`);
  }

  // Consecutive-loss recovery pause.
  let recoveryPauseUntil: string | null = settings?.recovery_pause_until ?? null;
  const now = Date.now();
  if (consecutiveLosses >= 5) {
    const until = new Date(now + 24 * 3600_000).toISOString();
    if (!recoveryPauseUntil || Date.parse(recoveryPauseUntil) < now) {
      recoveryPauseUntil = until;
      await supabase.from("automation_settings").update({ recovery_pause_until: until }).eq("user_id", userId);
    }
  } else if (consecutiveLosses >= 3) {
    const until = new Date(now + 3600_000).toISOString();
    if (!recoveryPauseUntil || Date.parse(recoveryPauseUntil) < now) {
      recoveryPauseUntil = until;
      await supabase.from("automation_settings").update({ recovery_pause_until: until }).eq("user_id", userId);
    }
  }
  if (recoveryPauseUntil && Date.parse(recoveryPauseUntil) > now) {
    blocks.push(`Recovery pause after ${consecutiveLosses} consecutive losses — resumes ${new Date(recoveryPauseUntil).toUTCString()}.`);
  }

  const capitalPreservation = totalDrawdownPct >= 10;
  if (capitalPreservation !== Boolean(settings?.capital_preservation_active)) {
    await supabase.from("automation_settings")
      .update({ capital_preservation_active: capitalPreservation }).eq("user_id", userId);
  }

  const openPositions = (open ?? []).length;
  const maxOpenPositions = maxPositionsForEquity(equity);
  if (openPositions >= maxOpenPositions) {
    blocks.push(`Max concurrent positions for $${equity.toFixed(0)} equity (${maxOpenPositions}) already open.`);
  }

  return {
    equity, highWater, dailyPnl, weeklyPnl,
    dailyDrawdownPct: +dailyDrawdownPct.toFixed(2),
    weeklyDrawdownPct: +weeklyDrawdownPct.toFixed(2),
    totalDrawdownPct: +totalDrawdownPct.toFixed(2),
    capitalPreservation, consecutiveLosses, recoveryPauseUntil,
    openPositions, maxOpenPositions,
    tradingAllowed: blocks.length === 0,
    blocks, limits,
  };
}

// ---------------------------------------------------------------------------
// Dynamic per-trade risk
// ---------------------------------------------------------------------------
export interface RiskSizingContext {
  confidence: number;              // 0..1 composite from the entry gate
  regimeTradable: boolean;
  trendStrength: "none" | "weak" | "moderate" | "strong";
  recentWinStreak?: number;
}

export function dynamicRiskPct(policy: PolicySnapshot, ctx: RiskSizingContext): {
  riskPct: number; notes: string[];
} {
  const notes: string[] = [];
  let risk = policy.limits.baseRiskPct;

  // Conviction ladder — spec: 0.25% low, 0.5% normal, 1% only on A+ setups.
  if (ctx.confidence >= 0.95 && ctx.trendStrength === "strong") {
    risk = 0.01; notes.push("A+ setup (>=95% confidence, strong trend) — 1.0% risk");
  } else if (ctx.confidence >= 0.9) {
    risk = 0.005; notes.push("High-conviction setup — 0.5% risk");
  } else {
    risk = RISK_FLOOR; notes.push("Below A-grade conviction — minimum 0.25% risk");
  }

  if (policy.capitalPreservation) {
    risk = RISK_FLOOR;
    notes.push("Capital-preservation mode (drawdown >= 10%) — risk floored at 0.25%");
  }
  if (policy.consecutiveLosses >= 2) {
    risk = Math.min(risk, 0.0035);
    notes.push(`${policy.consecutiveLosses} consecutive losses — risk reduced`);
  }
  if ((ctx.recentWinStreak ?? 0) >= 3 && !policy.capitalPreservation) {
    risk = Math.min(RISK_CEILING, risk * 1.2);
    notes.push("Positive streak — modest risk scale-up");
  }

  const riskPct = Math.min(RISK_CEILING, Math.max(RISK_FLOOR, risk));
  return { riskPct, notes };
}

// ---------------------------------------------------------------------------
// Correlation budget
// ---------------------------------------------------------------------------
export interface CorrelationDecision {
  allowed: boolean;
  reason?: string;
  clusterRiskPct: number;
  maxCorrelation: number;
}

/**
 * Rejects a new position when it is highly correlated (rho > 0.7) with open
 * positions and the combined cluster risk would exceed the budget.
 */
export async function checkCorrelationBudget(
  supabase: SupabaseClient,
  userId: string,
  symbol: string,
  newRiskPct: number,
  maxCorrelatedRiskPct: number,
): Promise<CorrelationDecision> {
  const { data: open } = await supabase.from("positions")
    .select("symbol, qty, avg_entry, stop_loss").eq("user_id", userId).eq("status", "open");
  if (!open?.length) return { allowed: true, clusterRiskPct: newRiskPct * 100, maxCorrelation: 0 };

  const series = async (s: string) =>
    (await fetchCandles(supabase, s, "1h", 120).catch(() => [])).map(c => c.close);

  const mine = await series(symbol);
  if (mine.length < 20) return { allowed: true, clusterRiskPct: newRiskPct * 100, maxCorrelation: 0 };

  let clusterRiskPct = newRiskPct * 100;
  let maxCorr = 0;
  const symbols = Array.from(new Set(open.map(p => p.symbol))).filter(s => s !== symbol);

  for (const s of symbols) {
    const other = await series(s);
    const rho = correlation(mine, other);
    maxCorr = Math.max(maxCorr, rho);
    if (rho > 0.7) {
      // Approximate the open position's risk share as its stop distance × qty.
      for (const p of open.filter(x => x.symbol === s)) {
        const stop = Number(p.stop_loss ?? 0);
        const entry = Number(p.avg_entry ?? 0);
        const риск = stop > 0 ? Math.abs(entry - stop) * Math.abs(Number(p.qty)) : 0;
        clusterRiskPct += риск > 0 ? 0 : 0; // notional risk added below
      }
      clusterRiskPct += newRiskPct * 100; // each correlated leg counts as a full unit of risk
    }
  }

  // Same-symbol duplication is never allowed.
  if (open.some(p => p.symbol === symbol)) {
    return { allowed: false, reason: `Already holding ${symbol} — no pyramiding.`, clusterRiskPct, maxCorrelation: 1 };
  }

  if (clusterRiskPct > maxCorrelatedRiskPct) {
    return {
      allowed: false,
      reason: `Correlated cluster risk ${clusterRiskPct.toFixed(2)}% would exceed the ${maxCorrelatedRiskPct}% budget (max rho ${maxCorr.toFixed(2)}).`,
      clusterRiskPct, maxCorrelation: maxCorr,
    };
  }
  return { allowed: true, clusterRiskPct, maxCorrelation: maxCorr };
}
