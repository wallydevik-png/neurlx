import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const DOC_VERSIONS = {
  tos: "2026-07-01",
  privacy: "2026-07-01",
  risk: "2026-07-01",
} as const;

type ConsentUpsert = {
  user_id: string;
  updated_at: string;
  tos_version?: string;
  tos_accepted_at?: string;
  privacy_version?: string;
  privacy_accepted_at?: string;
  risk_version?: string;
  risk_accepted_at?: string;
  marketing_opt_in?: boolean;
};

export const getMyCompliance = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [consentsRes, requestsRes, profileRes] = await Promise.all([
      context.supabase.from("user_consents").select("*").eq("user_id", context.userId).maybeSingle(),
      context.supabase.from("gdpr_requests").select("*").eq("user_id", context.userId).order("requested_at", { ascending: false }).limit(50),
      context.supabase.from("profiles").select("deletion_requested_at").eq("id", context.userId).maybeSingle(),
    ]);
    return {
      consents: consentsRes.data,
      requests: requestsRes.data ?? [],
      deletionRequestedAt: (profileRes.data as { deletion_requested_at?: string | null } | null)?.deletion_requested_at ?? null,
      versions: DOC_VERSIONS,
    };
  });

export const recordConsent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      tos: z.boolean().optional(),
      privacy: z.boolean().optional(),
      risk: z.boolean().optional(),
      marketing_opt_in: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const patch: ConsentUpsert = { user_id: context.userId, updated_at: now };
    if (data.tos) { patch.tos_version = DOC_VERSIONS.tos; patch.tos_accepted_at = now; }
    if (data.privacy) { patch.privacy_version = DOC_VERSIONS.privacy; patch.privacy_accepted_at = now; }
    if (data.risk) { patch.risk_version = DOC_VERSIONS.risk; patch.risk_accepted_at = now; }
    if (typeof data.marketing_opt_in === "boolean") patch.marketing_opt_in = data.marketing_opt_in;
    const { error } = await context.supabase.from("user_consents").upsert(patch, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "consent.recorded", entity: "user_consents",
      metadata: data as never,
    });
    return { ok: true };
  });

const EXPORT_TABLES = [
  "profiles", "user_consents", "paper_accounts", "automation_settings",
  "exchange_connections", "positions", "orders", "signals", "strategies",
  "backtest_runs", "backtest_trades", "shadow_trades", "trade_journal",
  "capital_snapshots", "notifications", "notification_preferences",
  "autonomous_runs", "audit_log", "execution_log",
] as const;

export const exportMyData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const bundle: Record<string, unknown[] | string> = {};
    bundle.__meta = JSON.stringify({ exported_at: new Date().toISOString(), user_id: context.userId });
    for (const t of EXPORT_TABLES) {
      const col = t === "profiles" ? "id" : "user_id";
      const q = context.supabase.from(t).select("*") as unknown as {
        eq: (c: string, v: string) => { limit: (n: number) => Promise<{ data: unknown[] | null }> };
      };
      const { data } = await q.eq(col, context.userId).limit(10000);
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      if (t === "exchange_connections") {
        for (const r of rows) r.encrypted_credentials = "[REDACTED]";
      }
      bundle[t] = rows;
    }
    const { data: req } = await context.supabase.from("gdpr_requests").insert({
      user_id: context.userId, kind: "export", status: "completed", completed_at: new Date().toISOString(),
    }).select().single();
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "gdpr.export", entity: "gdpr_requests", entity_id: req?.id ?? null,
    });
    // Serialize as string to avoid RPC serialization type friction; client parses.
    return { bundleJson: JSON.stringify(bundle), request: req };
  });

export const requestAccountDeletion = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ confirmPhrase: z.string() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    if (data.confirmPhrase !== "DELETE MY ACCOUNT") {
      throw new Error("Confirmation phrase does not match.");
    }
    await context.supabase.from("automation_settings").update({
      kill_switch_active: true, mode: "manual", autonomous_enabled: false,
    } as never).eq("user_id", context.userId);
    await context.supabase.from("exchange_connections").update({
      trading_enabled: false,
    } as never).eq("user_id", context.userId);
    await context.supabase.from("profiles").update({
      deletion_requested_at: new Date().toISOString(),
    } as never).eq("id", context.userId);
    const { data: req } = await context.supabase.from("gdpr_requests").insert({
      user_id: context.userId, kind: "delete", status: "pending",
      notes: "User requested account deletion — 30-day grace period before permanent purge.",
    }).select().single();
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "gdpr.deletion_requested", entity: "gdpr_requests", entity_id: req?.id ?? null,
    });
    return { ok: true, request: req };
  });

export const cancelDeletionRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("profiles").update({ deletion_requested_at: null } as never).eq("id", context.userId);
    await context.supabase.from("gdpr_requests").update({
      status: "cancelled", completed_at: new Date().toISOString(),
    }).eq("user_id", context.userId).eq("kind", "delete").eq("status", "pending");
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "gdpr.deletion_cancelled", entity: "gdpr_requests",
    });
    return { ok: true };
  });
