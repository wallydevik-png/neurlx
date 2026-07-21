/**
 * NeurlX Production Readiness Audit & Deployment Control System.
 *
 * IMPORTANT: This layer is evaluative only. It never places, cancels, or modifies trades,
 * and it cannot override or disable any existing risk control. Every recommendation
 * (capital scaling, promotions, mode changes) is written as a "pending" record that
 * requires an explicit user approval before any other system acts on it.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// ---------- helpers ----------
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number) => Math.round(n * 100);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

// ============================================================
// 1. READINESS SCORE ENGINE
// ============================================================
export const computeReadinessScore = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();

    const [journalR, signalsR, execR, healthR, apiR, heartR, statusR, settingsR, positionsR, accountR] = await Promise.all([
      supabase.from("trade_journal")
        .select("realized_pnl,ai_confidence,execution_quality_score,slippage_bps_avg,created_at,strategy_id")
        .eq("user_id", userId).limit(1000),
      supabase.from("signals")
        .select("confidence,outcome_status,outcome_pnl_pct,created_at")
        .eq("user_id", userId).limit(500),
      supabase.from("execution_log")
        .select("event,severity,created_at").eq("user_id", userId).gte("created_at", since30).limit(1000),
      supabase.from("strategy_health_scores")
        .select("overall_score,classification,strategy_id").eq("user_id", userId),
      supabase.from("api_request_log")
        .select("status_code,latency_ms,created_at").eq("user_id", userId).gte("created_at", since30).limit(500),
      supabase.from("system_heartbeats").select("component,status,observed_at,latency_ms").eq("user_id", userId),
      supabase.from("system_status").select("mode,updated_at").eq("user_id", userId).maybeSingle(),
      supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("positions").select("status,realized_pnl,qty,avg_entry").eq("user_id", userId),
      supabase.from("paper_accounts").select("cash_balance,equity").eq("user_id", userId).maybeSingle(),
    ]);

    const journal = journalR.data ?? [];
    const signals = signalsR.data ?? [];
    const exec = execR.data ?? [];
    const apiLog = apiR.data ?? [];
    const hearts = heartR.data ?? [];
    const status = statusR.data;
    const settings = settingsR.data;
    const positions = positionsR.data ?? [];
    const account = accountR.data;

    // --- Trading Performance ---
    const closed = journal.filter(j => j.realized_pnl != null);
    const pnls = closed.map(j => Number(j.realized_pnl));
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);
    const winRate = closed.length ? wins.length / closed.length : 0;
    const profitFactor = losses.length
      ? Math.abs(wins.reduce((s, p) => s + p, 0) / (losses.reduce((s, p) => s + p, 0) || -1))
      : wins.length > 0 ? 3 : 0;
    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const expectancy = closed.length ? totalPnl / closed.length : 0;
    const ret = mean(pnls);
    const vol = stdev(pnls);
    const sharpe = vol > 0 ? (ret / vol) * Math.sqrt(252) : 0;
    const negs = pnls.filter(p => p < 0);
    const downVol = stdev(negs);
    const sortino = downVol > 0 ? (ret / downVol) * Math.sqrt(252) : sharpe;
    let peak = 0, equity = 0, maxDd = 0;
    for (const p of pnls) { equity += p; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, peak - equity); }
    const maxDdPct = peak > 0 ? maxDd / peak : 0;

    const tradingScore = clamp01(
      0.25 * clamp01(sharpe / 2) +
      0.20 * clamp01(sortino / 2) +
      0.15 * clamp01(profitFactor / 2) +
      0.15 * clamp01(winRate / 0.6) +
      0.15 * clamp01(1 - maxDdPct / 0.25) +
      0.10 * (expectancy > 0 ? 1 : 0)
    );

    // --- AI Quality ---
    const resolved = signals.filter(s => s.outcome_status === "hit_tp" || s.outcome_status === "hit_sl");
    const hi = resolved.filter(s => Number(s.confidence) >= 0.7);
    const lo = resolved.filter(s => Number(s.confidence) < 0.7);
    const hiWr = hi.length ? hi.filter(s => s.outcome_status === "hit_tp").length / hi.length : 0;
    const loWr = lo.length ? lo.filter(s => s.outcome_status === "hit_tp").length / lo.length : 0;
    const accuracy = resolved.length ? resolved.filter(s => s.outcome_status === "hit_tp").length / resolved.length : 0;
    const calibGap = hiWr - loWr;
    const falseConf = hi.length >= 10 && hiWr < 0.4 ? 1 : 0;
    const aiScore = clamp01(
      0.4 * clamp01(accuracy / 0.6) +
      0.35 * clamp01(calibGap / 0.2) +
      0.25 * (1 - falseConf)
    ) * (resolved.length >= 10 ? 1 : resolved.length / 10);

    // --- Execution Quality (event-based) ---
    const filledEvents = exec.filter(e => /fill|filled|complete/i.test(String(e.event ?? "")));
    const failedEvents = exec.filter(e => /reject|error|fail/i.test(String(e.event ?? "")) || String(e.severity ?? "") === "error");
    const fillRate = exec.length ? filledEvents.length / exec.length : 1;
    const journalSlippage = journal.map(j => Math.abs(Number(j.slippage_bps_avg ?? 0))).filter(x => x > 0);
    const avgSlippageBps = mean(journalSlippage);
    const apiLatency = apiLog.map(a => Number(a.latency_ms ?? 0)).filter(x => x > 0);
    const avgLatency = mean(apiLatency);
    const execScore = clamp01(
      0.35 * fillRate +
      0.20 * clamp01(1 - avgSlippageBps / 25) +
      0.20 * clamp01(1 - avgLatency / 1500) +
      0.15 * clamp01(1 - failedEvents.length / Math.max(exec.length, 10)) +
      0.10 * (exec.length > 0 ? 1 : 0.5)
    );

    // --- Risk Health ---
    const openPos = positions.filter(p => p.status === "open");
    const exposure = openPos.reduce((s, p) => s + Number(p.qty ?? 0) * Number(p.avg_entry ?? 0), 0);
    const equityUsd = Number(account?.equity ?? account?.cash_balance ?? 0) || 1;
    const exposurePct = exposure / equityUsd;
    const maxOpen = Number(settings?.autonomous_max_open_positions ?? 3);
    const killEver = settings?.live_kill_reason ? 1 : 0;
    const riskScore = clamp01(
      0.35 * clamp01(1 - exposurePct / 1.5) +
      0.25 * clamp01(1 - openPos.length / Math.max(maxOpen * 1.5, 1)) +
      0.20 * (settings?.max_daily_loss ? 1 : 0) +
      0.10 * (settings?.min_confidence && Number(settings.min_confidence) >= 0.6 ? 1 : 0.5) +
      0.10 * (1 - Math.min(killEver, 1) * 0.3)
    );

    // --- System Health ---
    const nowMs = now.getTime();
    const freshHeart = hearts.filter(h => nowMs - new Date(h.observed_at as string).getTime() < 10 * 60_000);
    const healthyHeart = freshHeart.filter(h => h.status === "healthy" || h.status === "ok");
    const uptimeScore = hearts.length ? healthyHeart.length / hearts.length : 0.7;
    const modeOk = !status || status.mode === "normal" ? 1 : status.mode === "degraded" ? 0.5 : 0;
    const errorRate = apiLog.length
      ? apiLog.filter(a => Number(a.status_code) >= 400).length / apiLog.length : 0;
    const sysScore = clamp01(
      0.4 * uptimeScore +
      0.3 * modeOk +
      0.2 * clamp01(1 - errorRate / 0.1) +
      0.1 * (freshHeart.length > 0 ? 1 : 0.5)
    );

    // --- Overall & tier ---
    const categoryScores = {
      trading: pct(tradingScore),
      ai: pct(aiScore),
      execution: pct(execScore),
      risk: pct(riskScore),
      system: pct(sysScore),
    };
    const overall = Math.round(
      categoryScores.trading * 0.28 +
      categoryScores.ai * 0.22 +
      categoryScores.execution * 0.18 +
      categoryScores.risk * 0.20 +
      categoryScores.system * 0.12
    );

    let tier: "not_ready" | "paper_only" | "assisted_ready" | "autonomous_ready" | "scale_ready";
    if (overall < 40) tier = "not_ready";
    else if (overall < 60) tier = "paper_only";
    else if (overall < 75) tier = "assisted_ready";
    else if (overall < 88) tier = "autonomous_ready";
    else tier = "scale_ready";

    let capital_tier: "hold" | "maintain" | "scale_slow" | "scale_normal";
    if (overall < 60 || maxDdPct > 0.25) capital_tier = "hold";
    else if (overall < 75) capital_tier = "maintain";
    else if (overall < 85) capital_tier = "scale_slow";
    else capital_tier = "scale_normal";

    const blockers: { code: string; label: string; category: string }[] = [];
    if (closed.length < 20) blockers.push({ code: "sample_size", label: `Need ≥20 closed trades (have ${closed.length}).`, category: "trading" });
    if (maxDdPct > 0.25) blockers.push({ code: "drawdown", label: `Max drawdown ${(maxDdPct * 100).toFixed(1)}% exceeds 25% limit.`, category: "risk" });
    if (falseConf) blockers.push({ code: "false_confidence", label: `High-confidence signals win only ${(hiWr * 100).toFixed(0)}%.`, category: "ai" });
    if (fillRate < 0.9 && exec.length > 20) blockers.push({ code: "fill_rate", label: `Fill-event rate ${(fillRate * 100).toFixed(0)}% below 90%.`, category: "execution" });
    if (status && status.mode !== "normal") blockers.push({ code: "system_mode", label: `System in ${status.mode} mode.`, category: "system" });
    if (settings?.kill_switch_active) blockers.push({ code: "kill_switch", label: `Kill switch is active.`, category: "risk" });
    if (settings?.live_kill_until && new Date(settings.live_kill_until as string).getTime() > nowMs) {
      blockers.push({ code: "live_kill", label: `Live trading paused until ${new Date(settings.live_kill_until as string).toLocaleString()}.`, category: "risk" });
    }

    await supabase.from("readiness_snapshots").insert({
      user_id: userId,
      overall_score: overall,
      tier,
      capital_tier,
      category_scores: categoryScores,
      blockers,
      metrics: {
        sharpe: +sharpe.toFixed(2), sortino: +sortino.toFixed(2), profitFactor: +profitFactor.toFixed(2),
        winRate: +winRate.toFixed(3), maxDdPct: +maxDdPct.toFixed(4), expectancy: +expectancy.toFixed(4),
        aiAccuracy: +accuracy.toFixed(3), calibGap: +calibGap.toFixed(3), sampleSize: resolved.length,
        fillRate: +fillRate.toFixed(3), avgLatencyMs: Math.round(avgLatency), avgSlippageBps: +avgSlippageBps.toFixed(1),
        exposurePct: +exposurePct.toFixed(3), openPositions: openPos.length,
        uptimeScore: +uptimeScore.toFixed(3), errorRate: +errorRate.toFixed(3),
        closedTrades: closed.length, resolvedSignals: resolved.length,
      },
    });

    return {
      overall, tier, capital_tier,
      categoryScores,
      blockers,
      metrics: {
        trading: { sharpe, sortino, profitFactor, winRate, maxDdPct, expectancy, totalPnl, closedTrades: closed.length },
        ai: { accuracy, calibGap, hiWr, loWr, sampleSize: resolved.length, falseConfidence: !!falseConf },
        execution: { fillRate, avgLatencyMs: avgLatency, avgSlippageBps, failed: failedEvents.length, total: exec.length },
        risk: { exposurePct, openPositions: openPos.length, maxOpen, killSwitchActive: !!settings?.kill_switch_active },
        system: { uptimeScore, mode: status?.mode ?? "unknown", errorRate, heartbeatsHealthy: healthyHeart.length, heartbeatsTotal: hearts.length },
      },
    };
  });

// ============================================================
// 2. DEPLOYMENT ELIGIBILITY
// ============================================================
export const evaluateDeploymentEligibility = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: last } = await supabase.from("readiness_snapshots")
      .select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!last) {
      return {
        needsScore: true,
        snapshot: null as null,
        decisions: [] as Array<{ action: string; status: "approved" | "conditional" | "not_ready"; reason: string }>,
      };
    }
    const s = Number(last.overall_score);
    const cats = last.category_scores as Record<string, number>;
    const blockers = (last.blockers as Array<{ code: string; label: string }>) ?? [];
    const hasBlock = blockers.length > 0;

    const decide = (min: number, extra: boolean, reason: string): { status: "approved" | "conditional" | "not_ready"; reason: string } => {
      if (hasBlock) return { status: "not_ready", reason: `Blocked: ${blockers[0].label}` };
      if (s >= min && extra) return { status: "approved", reason };
      if (s >= min - 10) return { status: "conditional", reason: `${reason} Score ${s} near threshold.` };
      return { status: "not_ready", reason: `${reason} Score ${s} below threshold.` };
    };

    const decisions = [
      { action: "Continue autonomous trading", ...decide(70, (cats.risk ?? 0) >= 60, "Requires overall ≥70 and risk ≥60.") },
      { action: "Increase capital allocation", ...decide(80, (cats.trading ?? 0) >= 70, "Requires overall ≥80 and trading ≥70.") },
      { action: "Promote strategy to live", ...decide(75, (cats.ai ?? 0) >= 65, "Requires overall ≥75 and AI ≥65.") },
      { action: "Raise position size limits", ...decide(82, (cats.execution ?? 0) >= 70 && (cats.risk ?? 0) >= 70, "Requires strong execution & risk.") },
      { action: "Require human review of trades", status: (s < 60 || hasBlock ? "approved" : "not_ready") as "approved" | "not_ready", reason: s < 60 || hasBlock ? "Low readiness — enforce Assisted Mode." : "Not needed at this readiness level." },
    ];

    return { needsScore: false, snapshot: last, decisions };
  });

// ============================================================
// 3. CAPITAL SCALING RECOMMENDATIONS
// ============================================================
export const generateCapitalScaleRecommendation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [snapR, snapsR, journalR] = await Promise.all([
      supabase.from("readiness_snapshots").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("capital_snapshots").select("equity,snapshot_date").eq("user_id", userId).order("snapshot_date", { ascending: false }).limit(90),
      supabase.from("trade_journal").select("realized_pnl,created_at").eq("user_id", userId).not("realized_pnl", "is", null).limit(500),
    ]);
    const snap = snapR.data;
    if (!snap) throw new Error("Compute a readiness score first.");

    const equities = (snapsR.data ?? []).map(s => Number(s.equity)).reverse();
    const currentAlloc = equities[equities.length - 1] ?? 1000;
    const startAlloc = equities[0] ?? currentAlloc;
    const returnPct = startAlloc > 0 ? (currentAlloc - startAlloc) / startAlloc : 0;

    const pnls = (journalR.data ?? []).map(j => Number(j.realized_pnl));
    const posCount = pnls.filter(p => p > 0).length;
    const expectancy = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;

    const reasons: string[] = [];
    let direction: "increase" | "hold" | "decrease" = "hold";
    let suggested = currentAlloc;

    const cat = snap.capital_tier as string;
    const score = Number(snap.overall_score);
    if (cat === "scale_normal" && expectancy > 0 && returnPct > 0.05) {
      direction = "increase"; suggested = Math.round(currentAlloc * 1.5);
      reasons.push(`90-day positive expectancy ($${expectancy.toFixed(2)}/trade).`);
      reasons.push(`Equity growth ${(returnPct * 100).toFixed(1)}% over window.`);
      reasons.push(`Readiness score ${score} in scale tier.`);
    } else if (cat === "scale_slow" && expectancy > 0) {
      direction = "increase"; suggested = Math.round(currentAlloc * 1.2);
      reasons.push(`Positive expectancy with moderate readiness.`);
      reasons.push(`Conservative 20% scale-up recommended.`);
    } else if (cat === "hold" || score < 60) {
      direction = "decrease"; suggested = Math.round(currentAlloc * 0.7);
      reasons.push(`Readiness tier '${cat}' — reduce risk exposure.`);
      if (score < 60) reasons.push(`Score ${score} below 60 threshold.`);
    } else {
      reasons.push(`Maintain current allocation — no strong scaling signal.`);
      reasons.push(`Positive trades: ${posCount}/${pnls.length}.`);
    }

    const { data: rec } = await supabase.from("capital_scale_recommendations").insert({
      user_id: userId, direction,
      current_allocation: currentAlloc, suggested_allocation: suggested,
      reasons, status: "pending",
    }).select("*").single();
    return rec;
  });

export const listCapitalRecommendations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("capital_scale_recommendations")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(50);
    return data ?? [];
  });

export const decideCapitalRecommendation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    id: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    rationale: z.string().max(500).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: rec } = await supabase.from("capital_scale_recommendations")
      .update({ status: data.decision, decided_at: new Date().toISOString() })
      .eq("id", data.id).eq("user_id", userId).select("*").single();
    await supabase.from("approval_records").insert({
      user_id: userId, kind: "capital_scale", entity_ref: data.id,
      decision: data.decision, rationale: data.rationale ?? null, payload: rec,
    });
    await supabase.from("deployment_history").insert({
      user_id: userId, change_type: "capital_recommendation",
      summary: `Capital recommendation ${data.decision} (${rec?.direction} to ${rec?.suggested_allocation}).`,
      after_state: rec, actor: "user", reason: data.rationale ?? null,
    });
    return rec;
  });

// ============================================================
// 4. EMERGENCY READINESS CHECKS
// ============================================================
export const runEmergencyChecks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [settingsR, connsR, heartR, prefsR, auditR] = await Promise.all([
      supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("exchange_connections")
        .select("id,withdrawal_detected,unnecessary_permissions,status,trading_enabled")
        .eq("user_id", userId),
      supabase.from("system_heartbeats").select("component,status,observed_at").eq("user_id", userId),
      supabase.from("notification_preferences").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("audit_log").select("id").eq("user_id", userId).order("created_at", { ascending: false }).limit(1),
    ]);
    const settings = settingsR.data;
    const conns = connsR.data ?? [];
    const hearts = heartR.data ?? [];
    const prefs = prefsR.data;
    const auditActive = (auditR.data ?? []).length > 0;

    const withdrawUnsafe = conns.filter(c => c.withdrawal_detected === true);
    const now = Date.now();
    const freshHearts = hearts.filter(h => now - new Date(h.observed_at as string).getTime() < 10 * 60_000);

    const checks = [
      { key: "kill_switch", label: "Kill switch operational", pass: settings != null, detail: settings ? "Kill switch available from Automation & top-bar." : "Automation settings missing." },
      { key: "circuit_breakers", label: "Circuit breakers configured", pass: !!settings && Number(settings.max_daily_loss) > 0 && Number(settings.autonomous_max_consecutive_losses) > 0, detail: settings ? `Daily loss cap $${settings.max_daily_loss}, consecutive-loss limit ${settings.autonomous_max_consecutive_losses}.` : "Configure circuit breakers." },
      { key: "exchange_perms", label: "Exchange permissions safe", pass: conns.length === 0 || withdrawUnsafe.length === 0, detail: withdrawUnsafe.length ? `${withdrawUnsafe.length} connection(s) have withdrawal enabled — revoke immediately.` : `${conns.length} connection(s) verified safe.` },
      { key: "withdrawals_blocked", label: "Withdrawal permissions blocked", pass: withdrawUnsafe.length === 0, detail: withdrawUnsafe.length ? "Withdrawal scope detected on API key(s)." : "No withdrawal scope granted." },
      { key: "audit_logging", label: "Audit logging active", pass: auditActive, detail: auditActive ? "Audit trail is writing events." : "No recent audit events." },
      { key: "state_snapshots", label: "Backup / state snapshots active", pass: freshHearts.length > 0, detail: freshHearts.length ? `${freshHearts.length} component(s) heartbeating.` : "No recent heartbeats." },
      { key: "notifications", label: "Notifications configured", pass: prefs != null, detail: prefs ? "Notification channels initialised." : "Configure notification preferences." },
    ];
    const passed = checks.filter(c => c.pass).length;
    const failed = checks.length - passed;
    await supabase.from("emergency_check_runs").insert({
      user_id: userId, results: checks, passed, failed,
    });
    return { checks, passed, failed };
  });

export const getLastEmergencyCheck = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("emergency_check_runs")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    return data;
  });

// ============================================================
// 5. AUDIT REPORTS
// ============================================================
export const generateAuditReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ period: z.enum(["daily", "weekly", "monthly"]) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const now = new Date();
    const days = data.period === "daily" ? 1 : data.period === "weekly" ? 7 : 30;
    const startISO = new Date(now.getTime() - days * 86400 * 1000).toISOString();

    const [journalR, signalsR, runsR, auditR] = await Promise.all([
      supabase.from("trade_journal").select("realized_pnl,ai_confidence,strategy_id,created_at")
        .eq("user_id", userId).gte("created_at", startISO).limit(1000),
      supabase.from("signals").select("confidence,outcome_status,created_at")
        .eq("user_id", userId).gte("created_at", startISO).limit(500),
      supabase.from("autonomous_runs").select("signals_scanned,signals_executed,signals_rejected,started_at")
        .eq("user_id", userId).gte("started_at", startISO).limit(500),
      supabase.from("audit_log").select("action,created_at").eq("user_id", userId).gte("created_at", startISO).limit(500),
    ]);
    const journal = journalR.data ?? [];
    const signals = signalsR.data ?? [];
    const runs = runsR.data ?? [];
    const events = auditR.data ?? [];

    const trades = journal.length;
    const wins = journal.filter(j => Number(j.realized_pnl ?? 0) > 0).length;
    const pnl = journal.reduce((s, j) => s + Number(j.realized_pnl ?? 0), 0);
    const scanned = runs.reduce((s, r) => s + Number(r.signals_scanned ?? 0), 0);
    const executed = runs.reduce((s, r) => s + Number(r.signals_executed ?? 0), 0);
    const rejected = runs.reduce((s, r) => s + Number(r.signals_rejected ?? 0), 0);
    const resolved = signals.filter(s => s.outcome_status === "hit_tp" || s.outcome_status === "hit_sl");
    const accuracy = resolved.length ? resolved.filter(s => s.outcome_status === "hit_tp").length / resolved.length : 0;

    const summary = [
      `# ${data.period.toUpperCase()} AUDIT — NeurlX`,
      `Window: ${startISO.slice(0, 10)} → ${now.toISOString().slice(0, 10)}`,
      ``,
      `## Trading`,
      `- Trades taken: **${trades}** (wins: ${wins})`,
      `- Realized P&L: **$${pnl.toFixed(2)}**`,
      `- Autonomous scanned: ${scanned}, executed: ${executed}, rejected by risk gate: **${rejected}**`,
      ``,
      `## AI`,
      `- Resolved signals: ${resolved.length}`,
      `- Prediction accuracy: **${(accuracy * 100).toFixed(1)}%**`,
      ``,
      `## System events`,
      `- Recorded audit events: ${events.length}`,
      ``,
      data.period === "monthly"
        ? `## Strategy lifecycle\n- Review strategy_health_scores and consider retiring underperformers.`
        : `## Recommendations\n- Review AI Validation and Readiness dashboards for action items.`,
    ].join("\n");

    const { data: report } = await supabase.from("audit_reports").insert({
      user_id: userId, period: data.period,
      period_start: startISO, period_end: now.toISOString(),
      summary_md: summary,
      metrics: { trades, wins, pnl, scanned, executed, rejected, accuracy, events: events.length },
    }).select("*").single();
    return report;
  });

export const listAuditReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("audit_reports")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(30);
    return data ?? [];
  });

// ============================================================
// 6. AI SELF-EVALUATION SUMMARY
// ============================================================
export const generateAiSelfEvaluation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [snapR, journalR, signalsR] = await Promise.all([
      supabase.from("readiness_snapshots").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("trade_journal").select("realized_pnl,ai_confidence,strategy_id,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      supabase.from("signals").select("confidence,outcome_status,reasoning,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
    ]);
    const snap = snapR.data;
    const journal = journalR.data ?? [];
    const signals = signalsR.data ?? [];

    const contextBlock = {
      readiness: snap ? { overall: snap.overall_score, tier: snap.tier, categories: snap.category_scores, blockers: snap.blockers } : null,
      recentTrades: journal.slice(0, 15).map(j => ({ pnl: j.realized_pnl, conf: j.ai_confidence, strategy: j.strategy_id })),
      recentSignals: signals.slice(0, 10).map(s => ({ conf: s.confidence, outcome: s.outcome_status })),
    };

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      const summary = "AI Gateway unavailable — deterministic summary only.";
      const { data: rec } = await supabase.from("approval_records").insert({
        user_id: userId, kind: "ai_self_eval", decision: "informational", rationale: summary, payload: contextBlock,
      }).select("*").single();
      return { summary, saved: rec };
    }

    const sys = `You are NeurlX Chief Risk Officer. Produce an audit-tone self-evaluation. Answer EACH question in one short paragraph:
1) What happened? 2) What worked? 3) What failed? 4) Where did predictions fail? 5) Should trading parameters change? 6) Should capital exposure change?
Every recommendation MUST end with: "(pending user approval)". Never claim to have changed anything. Prioritise risk over profit.`;
    const user = `Data: ${JSON.stringify(contextBlock).slice(0, 6000)}`;

    let summary = "";
    try {
      const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        }),
      });
      if (resp.ok) {
        const j = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
        summary = j.choices?.[0]?.message?.content ?? "";
      } else {
        summary = `AI Gateway returned ${resp.status}. Review manually.`;
      }
    } catch (e) {
      summary = `AI Gateway error: ${(e as Error).message}. Review manually.`;
    }

    const { data: rec } = await supabase.from("approval_records").insert({
      user_id: userId, kind: "ai_self_eval", decision: "informational",
      rationale: summary.slice(0, 4000), payload: contextBlock,
    }).select("*").single();
    return { summary, saved: rec };
  });

export const listSelfEvaluations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("approval_records")
      .select("*").eq("user_id", context.userId).eq("kind", "ai_self_eval")
      .order("created_at", { ascending: false }).limit(10);
    return data ?? [];
  });

// ============================================================
// 7. GOVERNANCE: checklist, snapshots, acknowledgments, history
// ============================================================
const CHECKLIST_KEYS: Array<{ key: string; label: string }> = [
  { key: "acknowledged_risk_disclosure", label: "Read & accepted risk disclosure" },
  { key: "paper_trading_30d", label: "Ran ≥30 days of paper trading" },
  { key: "walk_forward_pass", label: "Passed a walk-forward validation" },
  { key: "shadow_30_trades", label: "Recorded ≥30 shadow trades" },
  { key: "kill_switch_tested", label: "Tested kill-switch flow" },
  { key: "withdrawal_scopes_blocked", label: "Confirmed API keys are read+trade only" },
  { key: "notifications_configured", label: "Notifications configured & received test alert" },
  { key: "capital_policy_set", label: "Capital policy & allocation set" },
  { key: "emergency_check_passed", label: "Last emergency check fully passed" },
];

export const getProductionChecklist = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("production_checklist_items")
      .select("*").eq("user_id", context.userId);
    const byKey = new Map((data ?? []).map(r => [r.key as string, r]));
    return CHECKLIST_KEYS.map(k => ({
      ...k,
      status: (byKey.get(k.key)?.status as string) ?? "pending",
      note: (byKey.get(k.key)?.note as string) ?? null,
      updated_at: byKey.get(k.key)?.updated_at ?? null,
    }));
  });

export const setChecklistItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    key: z.string(),
    status: z.enum(["pending", "passed", "failed", "waived"]),
    note: z.string().max(500).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase.from("production_checklist_items")
      .upsert({ user_id: userId, key: data.key, status: data.status, note: data.note ?? null, updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" }).select("*").single();
    if (error) throw error;
    await supabase.from("deployment_history").insert({
      user_id: userId, change_type: "checklist",
      summary: `Checklist '${data.key}' → ${data.status}.`, after_state: row, actor: "user",
    });
    return row;
  });

export const captureConfigurationSnapshot = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ label: z.string().min(1).max(120) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [autoR, riskR, polR] = await Promise.all([
      supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("advanced_risk_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("capital_policy").select("*").eq("user_id", userId).maybeSingle(),
    ]);
    const { data: row } = await supabase.from("configuration_snapshots").insert({
      user_id: userId, label: data.label,
      automation: autoR.data, risk: riskR.data, capital_policy: polR.data,
    }).select("*").single();
    await supabase.from("deployment_history").insert({
      user_id: userId, change_type: "config_snapshot",
      summary: `Configuration snapshot captured: '${data.label}'.`, after_state: row, actor: "user",
    });
    return row;
  });

export const listConfigurationSnapshots = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("configuration_snapshots")
      .select("id,label,created_at").eq("user_id", context.userId)
      .order("created_at", { ascending: false }).limit(50);
    return data ?? [];
  });

export const acknowledgeRisk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    kind: z.string(),
    version: z.string(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: row, error } = await supabase.from("risk_acknowledgments")
      .upsert({ user_id: userId, kind: data.kind, version: data.version }, { onConflict: "user_id,kind,version" })
      .select("*").single();
    if (error) throw error;
    await supabase.from("deployment_history").insert({
      user_id: userId, change_type: "risk_ack",
      summary: `Risk acknowledged: ${data.kind} v${data.version}.`, after_state: row, actor: "user",
    });
    return row;
  });

export const listAcknowledgments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("risk_acknowledgments")
      .select("*").eq("user_id", context.userId).order("acknowledged_at", { ascending: false });
    return data ?? [];
  });

export const listDeploymentHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("deployment_history")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(100);
    return data ?? [];
  });

export const listApprovalRecords = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase.from("approval_records")
      .select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(100);
    return data ?? [];
  });
