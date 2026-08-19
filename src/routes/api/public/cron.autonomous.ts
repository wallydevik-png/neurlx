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
        const requestStartedMs = Date.now();
        const requestBudgetMs = 45_000;
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

        // Reconciliation runs first: check whether the broker still actually
        // has each position open (margin call, manual close in MT5, etc. can
        // happen outside the app) before profit protection tries to manage
        // positions that may already be gone.
        const reconcileResults: Array<{ userId: string; checked: number; closed: number; adjusted: number; error?: string }> = [];
        const { data: liveTicketUsers } = await supabaseAdmin.from("broker_trade_tickets")
          .select("user_id").eq("state", "open");
        const liveUserIds = [...new Set((liveTicketUsers ?? []).map(t => t.user_id))];
        if (liveUserIds.length) {
          const { reconcileLivePositions } = await import("@/lib/execution/reconcile.server");
          for (const uid of liveUserIds) {
            try {
              const r = await reconcileLivePositions(supabaseAdmin, uid);
              reconcileResults.push({ userId: uid, ...r });
            } catch (e) {
              reconcileResults.push({
                userId: uid, checked: 0, closed: 0, adjusted: 0,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }

        // Profit protection must run for EVERY user with an open position,
        // not just users in autonomous mode — a manual/assisted-mode trader's
        // stop-loss and take-profit need enforcing too. Previously this only
        // ever ran when a user manually opened the old Positions page and
        // tapped a button; wiring it here makes it actually automatic.
        const protectionResults: Array<{ userId: string; actions: number; skipped: number; error?: string }> = [];
        const { data: openPositionUsers } = await supabaseAdmin.from("positions")
          .select("user_id").eq("status", "open");
        const uniqueUserIds = [...new Set((openPositionUsers ?? []).map(p => p.user_id))];
        if (uniqueUserIds.length) {
          const { runProfitProtection } = await import("@/lib/execution/positionManager.server");
          for (const uid of uniqueUserIds) {
            try {
              const r = await runProfitProtection(supabaseAdmin, uid);
              protectionResults.push({ userId: uid, ...r });
            } catch (e) {
              protectionResults.push({
                userId: uid, actions: 0, skipped: 0,
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }

        const { data: users, error } = await supabaseAdmin.from("automation_settings")
          .select("user_id,live_kill_until,live_kill_reason")
          .eq("mode", "autonomous")
          .eq("kill_switch_active", false);
        if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

        const results: Array<{ userId: string; executed: number; rejected: number; skipped?: string }> = [];
        for (const u of users ?? []) {
          if (Date.now() - requestStartedMs >= requestBudgetMs) {
            results.push({
              userId: u.user_id,
              executed: 0,
              rejected: 0,
              skipped: "deferred_to_next_tick",
            });
            continue;
          }
          if (u.live_kill_until && new Date(u.live_kill_until) > new Date()) {
            results.push({
              userId: u.user_id,
              executed: 0,
              rejected: 0,
              skipped: `circuit_breaker_open:${u.live_kill_reason ?? "open"}`,
            });
            continue;
          }
          // The breaker is time-based and auto-recovers, but the stale reason
          // text used to linger in the UI long after it expired. Clear it.
          if (u.live_kill_until && new Date(u.live_kill_until) <= new Date()) {
            await supabaseAdmin.from("automation_settings")
              .update({ live_kill_until: null, live_kill_reason: null, live_consecutive_failures: 0 })
              .eq("user_id", u.user_id);
          }

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
        // Memecoin sniper: independent of the MT5 autonomous mode, so it runs
        // for every user who has enabled it in the sniper controls.
        const memeResults: Array<{ userId: string; entries?: number; exits?: number; skipped?: string; error?: string }> = [];
        const { data: memeUsers } = await supabaseAdmin.from("memecoin_settings")
          .select("user_id").eq("enabled", true);
        if (memeUsers?.length) {
          const { runMemecoinCycle } = await import("@/lib/memecoin/engine.server");
          for (const m of memeUsers) {
            if (Date.now() - requestStartedMs >= requestBudgetMs) break;
            try {
              const r = await runMemecoinCycle(supabaseAdmin, m.user_id);
              memeResults.push({
                userId: m.user_id, entries: r.entries?.length ?? 0,
                exits: r.exits?.length ?? 0, skipped: r.skipped,
              });
            } catch (e) {
              memeResults.push({ userId: m.user_id, error: e instanceof Error ? e.message : String(e) });
            }
          }
        }

        return Response.json({
          ok: true, users: results.length, results,
          reconciliation: reconcileResults, protection: protectionResults,
          memecoin: memeResults,
        });

      },
    },
  },
});
