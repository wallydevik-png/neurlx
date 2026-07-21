import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const listNotifications = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [notifsRes, unreadRes, prefsRes] = await Promise.all([
      context.supabase.from("notifications").select("*")
        .eq("user_id", context.userId)
        .order("created_at", { ascending: false }).limit(200),
      context.supabase.from("notifications").select("id", { count: "exact", head: true })
        .eq("user_id", context.userId).is("read_at", null),
      context.supabase.from("notification_preferences").select("*")
        .eq("user_id", context.userId).maybeSingle(),
    ]);
    return {
      notifications: notifsRes.data ?? [],
      unread: unreadRes.count ?? 0,
      preferences: prefsRes.data,
    };
  });

export const unreadNotificationCount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { count } = await context.supabase.from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", context.userId).is("read_at", null);
    return { unread: count ?? 0 };
  });

export const markNotificationRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", data.id).eq("user_id", context.userId);
    return { ok: true };
  });

export const markAllNotificationsRead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", context.userId).is("read_at", null);
    return { ok: true };
  });

const PrefsSchema = z.object({
  channels: z.object({
    inapp: z.boolean(), email: z.boolean(), sms: z.boolean(),
    telegram: z.boolean(), discord: z.boolean(), push: z.boolean(),
  }),
  severity_min: z.enum(["info", "warning", "critical", "emergency"]),
  quiet_hours_start: z.number().int().min(0).max(23).nullable(),
  quiet_hours_end: z.number().int().min(0).max(23).nullable(),
  kind_toggles: z.record(z.string(), z.boolean()),
  email_address: z.string().email().nullable(),
  telegram_chat_id: z.string().nullable(),
  discord_webhook_url: z.string().url().nullable(),
});

export const updateNotificationPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PrefsSchema.parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase.from("notification_preferences").upsert({
      user_id: context.userId,
      ...data,
    });
    return { ok: true };
  });
