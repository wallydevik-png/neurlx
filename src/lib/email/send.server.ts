// Out-of-band email delivery.
//
// Withdrawal confirmation codes MUST NOT travel over the same channel as the
// session that requested the withdrawal — otherwise a stolen session holds
// both factors. This module is that separate channel.
//
// Server-only: reads provider credentials from process.env inside the call.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** True when a real transport is configured. Never guesses. */
export function emailTransportConfigured(): boolean {
  return Boolean(process.env["RESEND_API_KEY"]);
}

function fromAddress(): string {
  return process.env["VAULT_EMAIL_FROM"] ?? "NeurlX Security <security@neurlx.app>";
}

/**
 * Send one email. Throws when no transport is configured — callers in the
 * custody path must fail closed rather than silently downgrade to in-app
 * delivery.
 */
export async function sendEmail(msg: OutboundEmail): Promise<{ id: string }> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "Email delivery is not configured, so a withdrawal confirmation code cannot be " +
      "sent out-of-band. Set up the email domain before withdrawing.",
    );
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromAddress(),
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
      ...(msg.html ? { html: msg.html } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`Email delivery failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json() as { id?: string };
  return { id: json.id ?? "" };
}

/** Resolve the account's email address (auth identity, or a verified override). */
export async function accountEmail(userId: string): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: prefs } = await supabaseAdmin.from("notification_preferences")
    .select("email_address").eq("user_id", userId).maybeSingle();
  if (prefs?.email_address) return String(prefs.email_address);
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error) return null;
  return data.user?.email ?? null;
}

/** `al****@example.com` — safe to store and show without revealing the address. */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  const head = user.slice(0, 2);
  return `${head}${"*".repeat(Math.max(2, user.length - 2))}@${domain}`;
}
