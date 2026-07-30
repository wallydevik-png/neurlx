// Daily profit-target / loss-limit watcher. Reads realized P/L for the current
// day from the broker and notifies once per day per event.
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitNotification } from "@/lib/notifications/emit.server";
import { loadLiveDesk } from "@/lib/liveDesk/desk.server";

export interface DailyTargetResult {
  dailyPnl: number;
  target: number;
  lossLimit: number;
  hitTarget: boolean;
  hitLossLimit: boolean;
}

export async function evaluateDailyTargets(
  supabase: SupabaseClient,
  userId: string,
): Promise<DailyTargetResult> {
  const snap = await loadLiveDesk(supabase, userId);
  const { data: settings } = await supabase.from("automation_settings")
    .select("daily_profit_target, max_daily_loss").eq("user_id", userId).maybeSingle();

  const target = Number((settings as { daily_profit_target?: number } | null)?.daily_profit_target ?? 0);
  const lossLimit = Number((settings as { max_daily_loss?: number } | null)?.max_daily_loss ?? 0);
  const dailyPnl = snap.totals.dailyPnl;

  const today = new Date().toISOString().slice(0, 10);
  const hitTarget = target > 0 && dailyPnl >= target;
  const hitLossLimit = lossLimit > 0 && dailyPnl <= -Math.abs(lossLimit);

  async function notifyOnce(kind: string, severity: "info" | "critical", title: string, message: string) {
    const { data: existing } = await supabase.from("notifications")
      .select("id").eq("user_id", userId).eq("kind", kind)
      .gte("created_at", `${today}T00:00:00Z`).limit(1);
    if (existing?.length) return;
    await emitNotification(supabase, userId, {
      kind, severity, title, message,
      payload: { dailyPnl, target, lossLimit, currency: snap.totals.currency },
    });
  }

  if (hitTarget) {
    await notifyOnce("pnl.daily_target", "info", "Daily profit target reached",
      `Realized ${dailyPnl.toFixed(2)} ${snap.totals.currency} today (target ${target}).`);
  }
  if (hitLossLimit) {
    await notifyOnce("pnl.daily_loss_limit", "critical", "Daily loss limit reached",
      `Realized ${dailyPnl.toFixed(2)} ${snap.totals.currency} today (limit ${lossLimit}).`);
  }

  return { dailyPnl, target, lossLimit, hitTarget, hitLossLimit };
}
