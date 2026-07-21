// Autonomous cron endpoint — call periodically (e.g. every 60s) with header
//   Authorization: Bearer <AUTONOMOUS_CRON_SECRET>
// It runs the autonomous cycle for every user in autonomous mode with the
// kill switch disabled.
import { createFileRoute } from "@tanstack/react-router";
import { runAutonomousCycleFor } from "@/lib/autonomous.functions";

export const Route = createFileRoute("/api/public/cron/autonomous")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Accept either Authorization: Bearer <AUTONOMOUS_CRON_SECRET>
        // OR apikey header matching the project publishable key (pg_cron default).
        const secret = process.env.AUTONOMOUS_CRON_SECRET;
        const auth = request.headers.get("authorization") ?? "";
        const apikey = request.headers.get("apikey") ?? "";
        const publishable = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
        const okBearer = secret && auth === `Bearer ${secret}`;
        const okApiKey = publishable && apikey === publishable;
        if (!okBearer && !okApiKey) {
          return new Response("unauthorized", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: users, error } = await supabaseAdmin.from("automation_settings")
          .select("user_id")
          .eq("mode", "autonomous")
          .eq("kill_switch_active", false);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const results: Array<{ userId: string; executed: number; rejected: number; skipped?: string }> = [];
        for (const u of users ?? []) {
          try {
            const r = await runAutonomousCycleFor(supabaseAdmin, u.user_id, "cron");
            results.push({
              userId: u.user_id, executed: r.executed, rejected: r.rejected, skipped: r.skipped,
            });
          } catch (e) {
            results.push({
              userId: u.user_id, executed: 0, rejected: 0,
              skipped: e instanceof Error ? e.message : "error",
            });
          }
        }
        return Response.json({ ok: true, users: results.length, results });
      },
    },
  },
});
