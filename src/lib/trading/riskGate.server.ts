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

  if (settings.kill_switch_active) return { allowed: false, reason: "Emergency kill switch is active." };
  if (!input.stopLoss) return { allowed: false, reason: "Stop-loss is required for every trade." };
  if (!input.takeProfit) return { allowed: false, reason: "Take-profit is required for every trade." };
  if (input.confidence < Number(settings.min_confidence)) {
    return { allowed: false, reason: `Signal confidence ${input.confidence} below minimum ${settings.min_confidence}.` };
  }

  const notional = input.qty * input.entry;
  if (notional > Number(settings.max_trade_size)) {
    return { allowed: false, reason: `Position size $${notional.toFixed(2)} exceeds max trade size $${settings.max_trade_size}.` };
  }
  if (settings.allowed_assets && settings.allowed_assets.length > 0 &&
      !settings.allowed_assets.includes(input.symbol)) {
    return { allowed: false, reason: `${input.symbol} is not in your allowed assets list.` };
  }

  // Daily counters
  const dayStart = new Date(); dayStart.setUTCHours(0,0,0,0);
  const { data: todayOrders } = await supabase
    .from("orders").select("id").eq("user_id", userId).gte("created_at", dayStart.toISOString());
  if ((todayOrders?.length ?? 0) >= settings.max_trades_per_day) {
    return { allowed: false, reason: `Daily trade limit (${settings.max_trades_per_day}) reached.` };
  }

  const { data: todayClosed } = await supabase
    .from("positions").select("realized_pnl").eq("user_id", userId)
    .eq("status", "closed").gte("closed_at", dayStart.toISOString());
  const dailyPnl = (todayClosed ?? []).reduce((s, r) => s + Number(r.realized_pnl ?? 0), 0);
  if (dailyPnl < -Number(settings.max_daily_loss)) {
    return { allowed: false, reason: `Daily loss limit ($${settings.max_daily_loss}) breached — trading halted.` };
  }

  return { allowed: true };
}
