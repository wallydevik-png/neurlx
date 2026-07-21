// Notification emit helper — writes to `notifications` and (optionally) forwards
// to enabled external channels. Failures NEVER throw to the caller.
import type { SupabaseClient } from "@supabase/supabase-js";

export type Severity = "info" | "warning" | "critical" | "emergency";

const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0, warning: 1, critical: 2, emergency: 3,
};

export interface EmitInput {
  kind: string;                // e.g. "trade.executed", "autonomous.breaker"
  severity: Severity;
  title: string;
  message: string;
  payload?: Record<string, unknown>;
}

function inQuietHours(startHr: number | null, endHr: number | null): boolean {
  if (startHr == null || endHr == null) return false;
  const h = new Date().getUTCHours();
  if (startHr === endHr) return false;
  return startHr < endHr ? h >= startHr && h < endHr : h >= startHr || h < endHr;
}

export async function emitNotification(
  supabase: SupabaseClient,
  userId: string,
  input: EmitInput,
): Promise<void> {
  try {
    const { data: prefs } = await supabase.from("notification_preferences")
      .select("*").eq("user_id", userId).maybeSingle();

    const sevMin = (prefs?.severity_min ?? "info") as Severity;
    if (SEVERITY_ORDER[input.severity] < SEVERITY_ORDER[sevMin]
        && input.severity !== "emergency") return;

    const toggles = (prefs?.kind_toggles ?? {}) as Record<string, boolean>;
    if (toggles[input.kind] === false && input.severity !== "emergency") return;

    const quiet = inQuietHours(prefs?.quiet_hours_start ?? null, prefs?.quiet_hours_end ?? null);
    const bypassQuiet = input.severity === "emergency";
    const delivered: string[] = ["inapp"];

    const channels = (prefs?.channels ?? { inapp: true }) as Record<string, boolean>;
    if (channels.email && (!quiet || bypassQuiet) && prefs?.email_address) {
      // Best-effort email; ignore errors.
      try {
        const { sendTemplateEmail } = await import("@/lib/email-templates/send-email").catch(() => ({ sendTemplateEmail: null as never }));
        if (typeof sendTemplateEmail === "function") {
          await sendTemplateEmail("notification-generic", prefs.email_address, {
            templateData: { title: input.title, message: input.message, severity: input.severity },
            idempotencyKey: `notif-${userId}-${input.kind}-${Date.now()}`,
          });
          delivered.push("email");
        }
      } catch { /* swallow */ }
    }

    await supabase.from("notifications").insert({
      user_id: userId,
      kind: input.kind,
      severity: input.severity,
      title: input.title,
      message: input.message,
      payload: input.payload ?? {},
      channels_delivered: delivered,
    });
  } catch (e) {
    // Never let notification failures affect the trading path.
    console.error("[notifications.emit] failed", e);
  }
}
