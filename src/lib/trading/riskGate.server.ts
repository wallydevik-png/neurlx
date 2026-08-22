// Pre-trade risk checks. Every executed trade must pass this gate.
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RiskInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  confidence: number;
  equity?: number;
  connectionId?: string;
}

export interface RiskDecision {
  allowed: boolean;
  reason?: string;
}

export async function evaluateRisk(
  supabase: SupabaseClient,
  userId: string,
  input: RiskInput,
): Promise<RiskDecision> {
  const { data: settings } = await supabase
    .from("automation_settings").select("*").eq("user_id", userId).maybeSingle();
  if (!settings) return { allowed: false, reason: "Automation settings not initialized." };

  // Institutional capital-protection layer: drawdown circuit breakers,
  // recovery pauses and concurrent-position caps. Capital preservation first.
  const { loadPolicy, checkCorrelationBudget } = await import("@/lib/risk/policy.server");
  const policy = await loadPolicy(supabase, userId, input.equity, input.connectionId);
  if (!policy.tradingAllowed) return { allowed: false, reason: policy.blocks[0] };

  if (settings.kill_switch_active) return { allowed: false, reason: "Emergency kill switch is active." };
  if (!input.stopLoss) return { allowed: false, reason: "Stop-loss is required for every trade." };
  if (!input.takeProfit) return { allowed: false, reason: "Take-profit is required for every trade." };
  if (input.confidence < Number(settings.min_confidence)) {
    return { allowed: false, reason: `Signal confidence ${input.confidence} below minimum ${settings.min_confidence}.` };
  }

  const notional = input.qty * input.entry;
  // Dynamic sizing validation. There is no fixed dollar ceiling: a trade is
  // valid when the capital it puts at risk fits the risk-per-trade budget and
  // the notional fits the account's usable balance.
  const equity = Number(input.equity ?? policy.equity ?? 0);
  const stopDistance = input.stopLoss ? Math.abs(input.entry - input.stopLoss) : 0;
  if (equity > 0) {
    const { computeDynamicSize } = await import("@/lib/trading/dynamicSizing");
    const ceilingRiskPct = Math.max(Number(policy.limits.baseRiskPct) || 0.005, 0.01);
    const maxRiskAmount = equity * ceilingRiskPct;
    const riskAmount = stopDistance * input.qty;
    if (riskAmount > maxRiskAmount * 1.02 + 0.005) {
      return {
        allowed: false,
        reason:
          `Trade risks $${riskAmount.toFixed(2)} at stop, above the ` +
          `${(ceilingRiskPct * 100).toFixed(2)}% risk budget ($${maxRiskAmount.toFixed(2)}).`,
      };
    }
    // Notional must fit usable funds (10% buffer), same rule the sizer uses.
    const probe = computeDynamicSize({
      equity,
      availableBalance: equity,
      confidence: input.confidence,
      riskPct: ceilingRiskPct,
      entry: input.entry,
      stopLoss: input.stopLoss,
    });
    if (probe.maxNotional > 0 && notional > probe.maxNotional * 1.02 + 0.005) {
      return {
        allowed: false,
        reason:
          `Position notional $${notional.toFixed(2)} exceeds the dynamically ` +
          `calculated maximum $${probe.maxNotional.toFixed(2)} (${probe.binding}).`,
      };
    }
  }

  if (settings.allowed_assets && settings.allowed_assets.length > 0 &&
      !settings.allowed_assets.includes(input.symbol)) {
    return { allowed: false, reason: `${input.symbol} is not in your allowed assets list.` };
  }

  // Daily counters
  const dayStart = new Date(); dayStart.setUTCHours(0,0,0,0);
  const { data: todayOrders } = await supabase
    .from("orders").select("id")
    .eq("user_id", userId)
    .in("status", ["filled", "partially_filled", "working", "retrying"])
    .gte("created_at", dayStart.toISOString());
  if ((todayOrders?.length ?? 0) >= settings.max_trades_per_day) {
    return { allowed: false, reason: `Daily trade limit (${settings.max_trades_per_day}) reached.` };
  }

  let todayClosedQuery = supabase
    .from("positions").select("realized_pnl").eq("user_id", userId)
    .eq("status", "closed").gte("closed_at", dayStart.toISOString());
  todayClosedQuery = input.connectionId
    ? todayClosedQuery.eq("connection_id", input.connectionId)
    : todayClosedQuery.is("connection_id", null);
  const { data: todayClosed } = await todayClosedQuery;
  const dailyPnl = (todayClosed ?? []).reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
  if (dailyPnl < -Number(settings.max_daily_loss)) {
    return { allowed: false, reason: `Daily loss limit ($${settings.max_daily_loss}) breached — trading halted.` };
  }

  // Correlated-cluster exposure budget.
  const corr = await checkCorrelationBudget(
    supabase, userId, input.symbol,
    policy.limits.baseRiskPct, policy.limits.maxCorrelatedRiskPct,
  );
  if (!corr.allowed) return { allowed: false, reason: corr.reason };

  return { allowed: true };
}
