// Free-margin guard. While the account's free margin sits below the user's
// configured threshold, NeurlX stops opening new live trades but keeps managing
// (and closing) existing positions. Trading resumes automatically once margin
// recovers — the pause flag is cleared on the next healthy check.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TradingConnector } from "@/lib/connectors/types";
import { emitNotification } from "@/lib/notifications/emit.server";

export interface MarginGuardResult {
  ok: boolean;
  reason?: string;
  detail: {
    equity?: number;
    freeMargin?: number;
    freeMarginPct?: number;
    thresholdPct?: number;
  };
}

export async function checkMarginGuard(
  supabase: SupabaseClient,
  userId: string,
  connector: TradingConnector,
): Promise<MarginGuardResult> {
  if (!connector.getAccountSummary) return { ok: true, detail: {} };

  const summary = await connector.getAccountSummary().catch(() => null);
  if (!summary || !(summary.equity > 0)) return { ok: true, detail: {} };

  const { data: settings } = await supabase.from("automation_settings")
    .select("min_free_margin_pct, margin_pause_active")
    .eq("user_id", userId).maybeSingle();

  const thresholdPct = Number(
    (settings as { min_free_margin_pct?: number } | null)?.min_free_margin_pct ?? 20,
  );
  const freeMarginPct = (summary.freeMargin / summary.equity) * 100;
  const detail = {
    equity: summary.equity,
    freeMargin: summary.freeMargin,
    freeMarginPct: Number(freeMarginPct.toFixed(2)),
    thresholdPct,
  };
  const paused = (settings as { margin_pause_active?: boolean } | null)?.margin_pause_active === true;

  if (freeMarginPct < thresholdPct) {
    if (!paused) {
      await supabase.from("automation_settings")
        .update({ margin_pause_active: true }).eq("user_id", userId);
      await emitNotification(supabase, userId, {
        kind: "risk.margin_pause", severity: "critical",
        title: "New trades paused — low free margin",
        message: `Free margin is ${freeMarginPct.toFixed(1)}% of equity (threshold ${thresholdPct}%). Existing positions are still managed.`,
        payload: detail,
      });
    }
    return {
      ok: false,
      reason: `Skipped: free margin ${freeMarginPct.toFixed(1)}% is below the ${thresholdPct}% threshold — new trades paused.`,
      detail,
    };
  }

  if (paused) {
    await supabase.from("automation_settings")
      .update({ margin_pause_active: false }).eq("user_id", userId);
    await emitNotification(supabase, userId, {
      kind: "risk.margin_resume", severity: "info",
      title: "Trading resumed — margin recovered",
      message: `Free margin back to ${freeMarginPct.toFixed(1)}% of equity.`,
      payload: detail,
    });
  }
  return { ok: true, detail };
}
