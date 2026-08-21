// Autonomous Trading Engine
// -----------------------------------------------------------------------------
// Runs a bounded auto-execution cycle for users whose automation_settings.mode
// is "autonomous". Every cycle is idempotent, fully gated, and logged.
//
// Gates (all must pass before ANY order is placed):
//   1. mode === 'autonomous'
//   2. kill_switch_active === false AND live_kill_until in the past
//   3. cooldown: now >= autonomous_last_run_at + autonomous_cooldown_seconds
//   4. autonomous circuit breaker: last N closed positions not all losers
//   5. open positions < autonomous_max_open_positions
//   6. per-signal: confidence >= autonomous_min_confidence, symbol allowed
//   7. authoritative risk gate (evaluateRisk) — never bypassed
//   8. live only when autonomous_live_enabled AND default connection trading-enabled
//
// Every run inserts an autonomous_runs row with counts + reject reasons.
 
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
 
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CycleResult {
  runId: string;
  scanned: number;
  executed: number;
  /** Signals that reached a gate and were turned down by it (safety working). */
  rejected: number;
  /** Signals that never reached a gate because the cycle budget ran out. */
  deferred: number;
  /** Signals that threw — infrastructure/provider failures, not risk verdicts. */
  failed: number;
  rejectReasons: Record<string, number>;
  errors: string[];
  skipped?: string; // if the whole cycle was skipped
}
 
function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}
 
function withDetail(key: string, detail?: string) {
  return detail ? `${key}: ${detail}` : key;
}
 
function isRegionalConnectivityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("cloudfront")
    || message.includes("block access from your country")
    || message.includes("server region")
    || message.includes("u.s ip")
    || message.includes("us ip")
    || message.includes("403");
}
 
const BYBIT_REGION_BLOCKED_REASON = "Bybit region block — live autopilot paused because Bybit is rejecting the hosted app server IP. Configure a Bybit regional gateway from an allowed country or switch this account to another live venue.";
 
async function markConnectionRegionBlocked(
  supabase: SupabaseClient,
  connectionId: string,
  userId: string,
  detail: string,
) {
  const { data: conn } = await supabase.from("exchange_connections")
    .select("error_history")
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  const priorErrors = Array.isArray(conn?.error_history) ? conn.error_history : [];
  await supabase.from("exchange_connections").update({
    health: "danger",
    last_error: BYBIT_REGION_BLOCKED_REASON,
    error_history: [
      { at: new Date().toISOString(), message: BYBIT_REGION_BLOCKED_REASON, detail },
      ...priorErrors,
    ].slice(0, 10),
    last_sync_at: new Date().toISOString(),
  }).eq("id", connectionId).eq("user_id", userId);
}
 
// ---------------------------------------------------------------------------
// Core cycle — reusable from both the user-triggered fn and the cron route
// ---------------------------------------------------------------------------
async function runAutonomousCycleCore(
  supabase: SupabaseClient,
  userId: string,
  trigger: "manual" | "cron" | "signal",
  /** Lock ownership handle: the watchdog may only close the run row THIS
   *  invocation created, never whichever row happens to be open. */
  ownership?: { runId: string | null; abandoned?: boolean },
  /** Cycle-level cancellation. When it fires, the engine stops STARTING new
   *  work (market data, HTF, order submission) but keeps everything already
   *  completed. It is the mechanism that makes the watchdog safe. */
  cycleSignal?: AbortSignal,
): Promise<CycleResult> {
  const cycleStartedMs = Date.now();
  // Snapshot the process-global history telemetry so this run reports only its
  // own provider work rather than accumulating every earlier cron invocation.
  const { historyTimingCursor } = await import("@/lib/marketdata/historyGate.server");
  const { candleCacheTelemetryCursor } = await import("@/lib/marketdata/service.server");
  const historyCursor = historyTimingCursor();
  const cacheCursor = candleCacheTelemetryCursor();
  // Budget ladder (must stay ordered). Measured provider P95 for 1D history is
  // ~12s, so any HTF stage budget below that guarantees `htf:cycle_budget`
  // deferrals no matter how healthy the broker is:
  //   provider readiness 8s < 1D provider 12s < HTF stage 14s < committee 16s
  //   < cycle 40s < soft watchdog 42s < hard watchdog 50s
  const cycleBudgetMs = 40_000;

  const budgetLeftMs = () => cycleBudgetMs - (Date.now() - cycleStartedMs);
  const outOfBudget = () => Boolean(cycleSignal?.aborted) || budgetLeftMs() <= 0;
  const rejectReasons: Record<string, number> = {};
  const errors: string[] = [];
  let scanned = 0;
  // Symbols the connected broker actually lists as tradable. Populated during
  // signal generation; used to widen the execution allow-list beyond the
  // static `allowed_assets` watchlist.
  let brokerSymbols = new Set<string>();
  let executed = 0;
  let rejected = 0;
  // Deferred = never reached a gate (cycle budget). Failed = threw.
  // Neither is a rejection; conflating them makes safety gates look broken.
  let deferredCount = 0;
  let failedCount = 0;
 
  const startedAt = new Date().toISOString();
  // A 72-symbol broker scan can exceed the one-minute cron interval. Do not
  // let the next invocation start another scan for the same user while the
  // current one is still running; overlapping scans exhaust broker quotas and
  // leave misleading unfinished rows in the activity feed. The cron runs once
  // a minute, so a row still unfinished after 50 seconds cannot be allowed to
  // block the next invocation. Slow broker work below is separately bounded.
  const staleRunCutoff = new Date(Date.now() - 50 * 1000).toISOString();
  const { data: unfinishedRuns } = await supabase.from("autonomous_runs")
    .select("id,started_at")
    .eq("user_id", userId)
    .is("finished_at", null)
    .order("started_at", { ascending: false })
    .limit(10);
  const activeRun = (unfinishedRuns ?? []).find(run => run.started_at >= staleRunCutoff);
  if (activeRun) {
    const { data: skippedRun } = await supabase.from("autonomous_runs").insert({
      user_id: userId,
      started_at: startedAt,
      finished_at: startedAt,
      trigger,
      live: false,
      errors: [`skipped:cycle_already_running:${activeRun.id}`],
    }).select("id").single();
    return {
      runId: String(skippedRun?.id ?? "overlap-skipped"),
      scanned: 0,
      executed: 0,
      rejected: 0,
      deferred: 0,
      failed: 0,
      rejectReasons: {},
      errors: [`skipped:cycle_already_running:${activeRun.id}`],
      skipped: "cycle_already_running",
    };
  }
  const staleRunIds = (unfinishedRuns ?? [])
    .filter(run => run.started_at < staleRunCutoff)
    .map(run => run.id);
  if (staleRunIds.length) {
    await supabase.from("autonomous_runs").update({
      finished_at: startedAt,
      errors: ["recovered:stale_unfinished_cycle"],
    }).in("id", staleRunIds);
  }
  const { data: runRow, error: runInsertError } = await supabase.from("autonomous_runs").insert({
    user_id: userId, started_at: startedAt, trigger, live: false,
  }).select().single();
  // The database has a partial unique index for unfinished runs. This catches
  // the cron/manual race atomically even when both callers pass the read above.
  if (runInsertError?.code === "23505") {
    return {
      runId: "overlap-skipped",
      scanned: 0,
      executed: 0,
      rejected: 0,
      deferred: 0,
      failed: 0,
      rejectReasons: {},
      errors: ["skipped:cycle_already_running:atomic_lock"],
      skipped: "cycle_already_running",
    };
  }
  if (runInsertError || !runRow?.id) {
    throw new Error(`autonomous_run_start_failed:${runInsertError?.message ?? "missing run id"}`);
  }
  const runId = runRow?.id as string;
  if (ownership) ownership.runId = runId;
 
  const finish = async (skipped?: string, live = false) => {
    // Where the cycle's market-data time actually went: queue wait vs provider
    // latency, measured per request. This is what tells a saturated gate apart
    // from a slow broker without guessing.
    let timingNote: string | null = null;
    try {
      const { historyTimingSummarySince } = await import("@/lib/marketdata/historyGate.server");
      const { candleCacheTelemetrySince } = await import("@/lib/marketdata/service.server");
      const s = historyTimingSummarySince(historyCursor);
      if (s) {
        timingNote =
          `history_timing:n=${s.n}:queue_avg=${s.queueAvg}:queue_p50=${s.queueP50}:queue_p95=${s.queueP95}` +
          `:provider_avg=${s.providerAvg}:provider_p50=${s.providerP50}:provider_p95=${s.providerP95}:provider_max=${s.providerMax}` +
          `:provider_concurrency_max=${s.maxProviderConcurrency}` +
          `:failed=${s.failed}(queue=${s.queuePhaseFailures},provider=${s.providerPhaseFailures})`;
      }
      const cache = candleCacheTelemetrySince(cacheCursor);
      errors.push(`candle_reuse:provider=${cache.providerStarts}:cache=${cache.cacheHits}:coalesced=${cache.coalescedJoins}`);
      errors.push(`cycle_elapsed_ms:${Date.now() - cycleStartedMs}`);
    } catch { /* telemetry only */ }
    const base = timingNote ? [...errors, timingNote] : errors;
    const runErrors = skipped ? [...base, withDetail("skipped", skipped)] : base;

    await supabase.from("autonomous_runs").update({
      finished_at: new Date().toISOString(),
      signals_scanned: scanned, signals_executed: executed, signals_rejected: rejected,
      signals_deferred: deferredCount, signals_failed: failedCount,
      reject_reasons: rejectReasons, errors: runErrors, live,
      // A cycle the hard watchdog already abandoned must not rewrite the row it
      // closed; `.is(finished_at, null)` makes this update a no-op in that case.
    }).eq("id", runId).is("finished_at", null);
    try {
      const { recordRejectionStages } = await import("@/lib/autonomous/rejectionStats.server");
      await recordRejectionStages(supabase, userId, runErrors, rejectReasons);
    } catch { /* telemetry must never break a cycle */ }
    return {
      runId, scanned, executed, rejected,
      deferred: deferredCount, failed: failedCount,
      rejectReasons, errors: runErrors, skipped,
    };
  };
 
 
  // 1. Load settings
  const { data: settings } = await supabase.from("automation_settings")
    .select("*").eq("user_id", userId).maybeSingle();
  if (!settings) return finish("no_settings");
  const wantsLive = Boolean(settings.autonomous_live_enabled)
    && Boolean(settings.autonomous_default_connection_id);
  const stalePendingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count: staleLivePending } = await supabase.from("orders").update({
    status: "error",
    error_message: "Auto-cleaned: order never reached the venue and has no exchange order id.",
  }, { count: "exact" })
    .eq("user_id", userId)
    .eq("is_live", true)
    .eq("status", "pending")
    .is("external_order_id", null)
    .lt("created_at", stalePendingCutoff);
  if ((staleLivePending ?? 0) > 0) {
    errors.push(`cleaned_stale_live_pending:${staleLivePending}`);
  }
  if (settings.mode !== "autonomous") return finish("mode_not_autonomous", wantsLive);
  if (settings.kill_switch_active) return finish("kill_switch_active", wantsLive);
  if (wantsLive && settings.live_kill_reason?.includes("5 rejected orders today")) {
    await supabase.from("automation_settings").update({
      live_kill_until: null,
      live_kill_reason: null,
      live_rejected_today: 0,
    }).eq("user_id", userId);
    settings.live_kill_until = null;
    settings.live_kill_reason = null;
    settings.live_rejected_today = 0;
    errors.push("cleared_balance_rejection_breaker");
  }
  if (settings.live_kill_until && new Date(settings.live_kill_until) > new Date()) {
    return finish(`circuit_breaker_open:${settings.live_kill_reason ?? "open"}`, wantsLive);
  }
 
  // 2. Cooldown
  if (settings.autonomous_last_run_at) {
    const nextAllowed = new Date(settings.autonomous_last_run_at).getTime()
      + (settings.autonomous_cooldown_seconds ?? 300) * 1000;
    if (Date.now() < nextAllowed && trigger !== "manual") {
      return finish(`cooldown_until:${new Date(nextAllowed).toISOString()}`, wantsLive);
    }
  }
 
  // 3. Autonomous consecutive-loss breaker (stateless — query last N closes)
  const maxLosses = settings.autonomous_max_consecutive_losses ?? 3;
  const { data: recentCloses } = await supabase.from("positions")
    .select("realized_pnl,closed_at")
    .eq("user_id", userId).eq("status", "closed")
    .order("closed_at", { ascending: false }).limit(maxLosses);
  if (recentCloses && recentCloses.length >= maxLosses
      && recentCloses.every(p => Number(p.realized_pnl ?? 0) < 0)) {
    await supabase.from("automation_settings").update({
      autonomous_consecutive_losses: recentCloses.length,
      live_kill_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      live_kill_reason: `${maxLosses} consecutive losses — autonomous paused 24h.`,
    }).eq("user_id", userId);
    await supabase.from("execution_log").insert({
      user_id: userId, event: "autonomous.breaker.consecutive_losses",
      severity: "critical",
      message: `${maxLosses} consecutive losing trades — autonomous halted.`,
      payload: {},
    });
    const { emitNotification } = await import("@/lib/notifications/emit.server");
    await emitNotification(supabase, userId, {
      kind: "autonomous.breaker", severity: "emergency",
      title: "Autonomous trading paused",
      message: `${maxLosses} consecutive losses — autonomous halted for 24h.`,
      payload: { maxLosses },
    });
    return finish("consecutive_losses_breaker", wantsLive);
  }
 
  // 4. Max open positions
  const { count: openCount } = await supabase.from("positions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId).eq("status", "open");
  const capacity = Math.max(0, (settings.autonomous_max_open_positions ?? 3) - (openCount ?? 0));
  if (capacity === 0) return finish("no_open_slots", wantsLive);
 
  // 5. Daily loss cap check (reuse existing paper account tracking)
  const { data: paperAcct } = await supabase.from("paper_accounts")
    .select("*").eq("user_id", userId).maybeSingle();
 
  // 6. Determine live routing
  let liveConn: {
    id: string;
    trading_enabled: boolean;
    status: string;
    connector_id: string;
    withdrawal_detected?: boolean | null;
    credential_ciphertext?: string | null;
  } | null = null;
  let liveStableUsd = 0;
  let liveWalletUnavailableReason: string | null = null;
  let liveBaseAvailable = new Map<string, number>();
  if (wantsLive) {
    const { data: c } = await supabase.from("exchange_connections")
      .select("id,trading_enabled,status,connector_id,withdrawal_detected,credential_ciphertext")
      .eq("id", settings.autonomous_default_connection_id!)
      .eq("user_id", userId).maybeSingle();
    if (!c) return finish("live_connection_missing", true);
    if (c.withdrawal_detected) {
      errors.push("live_permission_warning: previous scan saw withdrawal permission; pre-trade check will rescan before any order can reach the venue");
    }
    if (c.trading_enabled && c.status === "connected" && c.connector_id !== "paper") {
      liveConn = c;
      try {
        const { decryptJSON } = await import("@/lib/crypto.server");
        const { createConnector } = await import("@/lib/connectors/factory.server");
        const creds = c.credential_ciphertext
          ? await decryptJSON<Record<string, string>>(c.credential_ciphertext)
          : {};
        const connector = createConnector(c.connector_id, creds, { supabase, userId, connectionId: c.id });
        if (connector.checkHealth) {
          const health = await connector.checkHealth();
          if (!health.ok) throw new Error(health.message || "Regional trading gateway health check failed");
        }
        const balances = await connector.getBalances();
        liveStableUsd = balances
          .filter(b => ["USD", "USDT", "USDC"].includes(b.currency.toUpperCase()))
          .reduce((sum, b) => sum + Math.max(0, Number(b.available ?? 0)), 0);
        liveBaseAvailable = new Map(balances.map(b => [b.currency.toUpperCase(), Math.max(0, Number(b.available ?? 0))]));
        errors.push(`live_wallet:stable=${liveStableUsd.toFixed(2)}:${balances.filter(b => Number(b.available ?? 0) > 0).map(b => `${b.currency}:${Number(b.available).toFixed(6)}`).slice(0, 5).join(",")}`);
      } catch (e) {
        liveWalletUnavailableReason = e instanceof Error ? e.message : String(e);
        errors.push(`live_wallet_unavailable:${liveWalletUnavailableReason}`);
      }
    } else {
      return finish(`live_connection_not_ready:${c.connector_id}:${c.status}:trading_enabled=${c.trading_enabled}`, true);
    }
  }
  const live = liveConn !== null;
  if (live && liveWalletUnavailableReason) {
    const isRegionBlocked = isRegionalConnectivityError(liveWalletUnavailableReason);
    const reason = isRegionBlocked
      ? `live_wallet_region_blocked: ${BYBIT_REGION_BLOCKED_REASON}`
      : `live_wallet_unavailable:${liveWalletUnavailableReason}`;
    if (isRegionBlocked && liveConn) {
      await markConnectionRegionBlocked(supabase, liveConn.id, userId, liveWalletUnavailableReason);
      await supabase.from("automation_settings").update({
        live_kill_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        live_kill_reason: BYBIT_REGION_BLOCKED_REASON,
      }).eq("user_id", userId);
      await supabase.from("execution_log").insert({
        user_id: userId,
        event: "autonomous.region_blocked",
        severity: "critical",
        message: BYBIT_REGION_BLOCKED_REASON,
        payload: { connectionId: liveConn.id, detail: liveWalletUnavailableReason },
      });
    }
    return finish(reason, true);
  }
 
  // 7. Pull pending signals — and if none exist, have the AI committee
  // generate fresh ones from the user's allowed_assets watchlist. This is
  // what makes autopilot truly hands-free: the loop doesn't wait for the
  // user to press "Generate signal" in the UI.
  // Execution floor (strict) vs generation floor (permissive) — so the
  // signals table always shows recent AI activity, even when nothing clears
  // the auto-execute bar. Auto-execute still enforces minConf below.
  const minConfForExec = Number(settings.autonomous_min_confidence ?? 0.85);
  const minConfForGen = Math.min(minConfForExec, 0.6);
  await supabase.from("signals").update({
    status: "expired", resolved_at: new Date().toISOString(),
  }).eq("user_id", userId).eq("status", "pending").lt("expires_at", new Date().toISOString());
  let { data: signals } = await supabase.from("signals")
    .select("*").eq("user_id", userId).eq("status", "pending")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(20);
 
  // Margin venues (MT5, OANDA) can open short positions without holding the
  // base asset — sizing a sell against a spot base balance made every
  // short-side idea unfundable, which is why cycles only ever produced BUY
  // candidates into bearish higher timeframes.
  const SHORT_CAPABLE = new Set(["mt5", "oanda"]);
  const marginVenue = live && !!liveConn && SHORT_CAPABLE.has(liveConn.connector_id);
  const canFundLiveSignal = (symbol: string, side: "buy" | "sell") => {
    if (!live) return true;
    if (side === "buy" || marginVenue) return liveStableUsd > 1;
    const base = symbol.includes("-") ? symbol.split("-")[0].toUpperCase() : symbol.replace(/USDT$|USD$|USDC$/, "").toUpperCase();
    return (liveBaseAvailable.get(base) ?? 0) > 0;
  };
 
 
  if (live && signals?.length) {
    const fundable = [];
    for (const sig of signals) {
      const side = sig.side as "buy" | "sell";
      if (canFundLiveSignal(sig.symbol, side)) {
        fundable.push(sig);
      } else {
        rejected++;
        bump(rejectReasons, side === "buy" ? "wallet:no_stablecoin_available" : `wallet:no_${sig.symbol.split("-")[0] ?? "base"}_available`);
        await supabase.from("signals").update({
          status: "rejected", resolved_at: new Date().toISOString(),
        }).eq("id", sig.id);
      }
    }
    signals = fundable;
  }
 
  if ((!signals || signals.length === 0) && capacity > 0) {
    try {
      const { runCommittee } = await import("@/lib/trading/committee.server");
      const { listTradableSymbols } = await import("@/lib/marketdata/service.server");
      const { filterScanUniverse, isMemeSymbol } = await import("@/lib/marketdata/assetClass");
      // The scan universe is the UNION of the user's watchlist and the
      // connected broker's real tradable list, restricted to the instrument
      // families this engine is calibrated for: crypto, major forex and index
      // CFDs. Individual equities / international share CFDs (BKNGNAS, AAPL,
      // SAP.de …) are dropped outright rather than patched name-by-name.
      const rawTradable = await listTradableSymbols(supabase, userId);
      const tradable = filterScanUniverse(rawTradable);
      brokerSymbols = new Set(tradable);
      // A live broker cycle must only request instruments that broker actually
      // exposes. Unioning the watchlist added on-chain meme tokens that MT5 did
      // not list, wasting most of the committee window on guaranteed failures.
      const fullUniverse = tradable.length
        ? Array.from(new Set(tradable))
        : Array.from(new Set(filterScanUniverse(settings.allowed_assets ?? [])));
      // Scan a rotating, bounded slice instead of trying to download hundreds
      // of broker candles inside one serverless request. The most liquid
      // instruments are always checked; the remainder rotates every minute so
      // the complete crypto/major-FX/index universe is still covered quickly.
      // Anchors were previously nine names (crypto + majors + indices), which
      // consumed nine of the ten slots and left crypto/meme rotation starved
      // while FX/indices sat in mid-session chop. Only the three round-the-clock
      // crypto majors are permanently anchored now; FX and index CFDs join the
      // ordinary rotation pool so they still get covered, just not every cycle.
      const anchors = [
        "BTC-USD", "ETH-USD", "SOL-USD",
      ].filter(symbol => fullUniverse.includes(symbol));
      // Meme coins get dedicated slots every cycle so high-beta names are
      // never starved by the alphabetical rotation.
      const memes = fullUniverse.filter(s => !anchors.includes(s) && isMemeSymbol(s));
      const memeStart = memes.length
        ? (Math.floor(Date.now() / 60_000) * 4) % memes.length
        : 0;
      const batchSize = 10;
      const anchorSlice = anchors.slice(0, batchSize);
      const memeSlots = Math.max(0, Math.min(4, batchSize - anchorSlice.length));
      const memeSlice = memes.length
        ? [...memes.slice(memeStart), ...memes.slice(0, memeStart)].slice(0, memeSlots)
        : [];
      const rotating = fullUniverse.filter(
        symbol => !anchorSlice.includes(symbol) && !memeSlice.includes(symbol),
      );
      // Ten symbols fit reliably inside the server request budget. The former
      // 22-symbol batch was paired with a 22-second Promise.race that discarded
      // every completed verdict when the slowest broker calls crossed the
      // deadline. Smaller rotating batches complete instead of reporting a
      // misleading zero-result timeout, while still covering the full universe.
      const rotationSlots = Math.max(0, batchSize - anchorSlice.length - memeSlice.length);
      const rotationStart = rotating.length
        ? (Math.floor(Date.now() / 60_000) * Math.max(1, rotationSlots)) % rotating.length
        : 0;
      const rotated = rotating.length
        ? [...rotating.slice(rotationStart), ...rotating.slice(0, rotationStart)]
        : [];
      const universe = [...anchorSlice, ...memeSlice, ...rotated.slice(0, rotationSlots)];
 
      // "scanned" now means symbols evaluated by the AI committee — the
      // honest metric. Signals produced are reported separately below.
      scanned = universe.length;
      errors.push(
        `universe:${universe.length}:watchlist=${(settings.allowed_assets ?? []).length}` +
        `:broker=${tradable.length}/${rawTradable.length}(non-equity)`,
      );
      // The committee owns its deadline and returns whichever verdicts have
      // completed. Do not wrap it in an outer Promise.race: that left broker
      // requests running after the cycle had been marked failed, causing the
      // next manual/cron invocation to collide with an unfinished cycle.
      const { StageRecorder, assessCoverage } = await import("@/lib/marketdata/symbolTelemetry");
      const stages = new StageRecorder();
      const verdicts = await runCommittee(supabase, universe, userId, {
        // Never let the committee outlive the cycle budget.
        deadlineMs: Math.max(5_000, Math.min(16_000, budgetLeftMs() - 18_000)),
        ...(cycleSignal ? { signal: cycleSignal } : {}),
        onStage: (symbol, stage, detail) => stages.record(symbol, stage, detail),
      });
      // Per-symbol market-data telemetry: the actual stage each symbol reached,
      // never a single global error.
      errors.push(`market_data_stages:${stages.summary()}`);
      const coverage = assessCoverage(stages.all());
      // Scoped deliberately: this is the COMMITTEE stage's coverage only. HTF,
      // momentum and the entry gate fetch their own timeframes afterwards and
      // report their own availability — a "10/10" here never meant that every
      // required symbol/timeframe downstream was available.
      errors.push(
        `committee_data_coverage:${coverage.completed}/${coverage.attempted}` +
        `:failures=${coverage.dataFailures}:deferred=${coverage.deferred}`,
      );

      if (coverage.deferred > 0) {
        deferredCount += coverage.deferred;
        for (const st of stages.all().filter(x => x.stage === "deferred")) {
          errors.push(`signal_deferred:${st.symbol}:market_data:cycle_budget`);
        }
      }
      for (const st of stages.all()) {
        if (st.stage !== "completed" && st.stage !== "deferred") {
          errors.push(`signal_failed:${st.symbol}:market_data:${st.detail ?? st.stage}`);
        }
      }
      const canFundVerdict = (symbol: string, side: "buy" | "sell" | "wait") => {
        if (side === "wait") return true;
        return canFundLiveSignal(symbol, side);
      };
 
      // Feed the institutional gate a sufficiently broad candidate set. The
      // previous `capacity`-sized slice stopped after the three highest-ranked
      // committee ideas, so three compressed/low-volatility instruments could
      // end a 91-symbol cycle even when tradable setups existed farther down
      // the ranking. Reject obviously untradable regimes early and inspect up
      // to four candidates per available slot; the downstream entry, lifecycle,
      // portfolio, risk and execution gates remain authoritative.
      const candidateLimit = Math.min(12, Math.max(6, capacity * 4));
      // Every directional verdict is dropped for exactly ONE recorded reason.
      // "committee_no_trade" is reserved for the case where the committee
      // itself produced no directional opinion — it is never used as a catch
      // all for funding, momentum, regime or higher-timeframe outcomes.
      const preHtfDrops: string[] = [];
      const viable: typeof verdicts = [];
      let waitVerdicts = 0;
      for (const v of verdicts) {
        const dir = v.consensusDirection;
        if (dir === "wait") { waitVerdicts++; continue; }
        let reason: string | null = null;
        if (!canFundVerdict(v.symbol, dir)) reason = `wallet:${dir === "buy" ? "no_stablecoin_available" : "no_base_asset_available"}`;
        else if (v.consensusConfidence < minConfForGen) reason = `below_generation_confidence:${v.consensusConfidence.toFixed(2)}`;
        else if (v.agreement < 1 / 2) reason = `committee_no_majority:${v.agreement.toFixed(2)}`;
        else if (!v.entryMomentumConfirmed) reason = "entry_momentum:not_confirmed";
        else if (v.base.regime === "extreme_risk") reason = "regime:extreme_risk";
        if (reason) {
          preHtfDrops.push(`${v.symbol}:${dir}:${reason}`);
          bump(rejectReasons, reason.split(":").slice(0, 2).join(":"));
          rejected++;
          continue;
        }
        viable.push(v);
      }
      if (preHtfDrops.length) {
        errors.push(`candidates_dropped_pre_htf:${preHtfDrops.length}:${preHtfDrops.slice(0, 5).join(" | ")}`);
      }
      // Counter-trend candidates are guaranteed to fail the entry gate's
      // higher-timeframe alignment check, so they must not consume the batch.
      // Uses REAL 1D/4H/1H broker candles.
      const { filterHtfAligned } = await import("@/lib/trading/htfFilter.server");
      const htf = await filterHtfAligned(
        supabase,
        viable,
        v => v.consensusDirection as "buy" | "sell",
        userId,
        Math.min(viable.length, 12),
        // Four task workers fill the four-slot history gate without bypassing
        // it. Work is scheduled per timeframe, so one slow symbol cannot block
        // every timeframe for all later candidates.
        4,
        {
          ...(cycleSignal ? { signal: cycleSignal } : {}),
          deadlineMs: Math.max(3_000, Math.min(17_000, budgetLeftMs() - 10_000)),
        },
      );
      errors.push(`htf_coverage:completed=${htf.verdicts.length}:deferred=${htf.deferred.length}:failed=${htf.failed.length}`);
      for (const [symbol, timing] of Object.entries(htf.timings)) {
        const detail = (["d1", "h4", "h1"] as const).map(tf => {
          const t = timing[tf];
          return t ? `${tf}[q=${t.queueMs},p=${t.providerMs},t=${t.totalMs},${t.outcome}${t.reason ? `:${t.reason}` : ""}]` : `${tf}[not_started]`;
        }).join(";");
        errors.push(`htf_timing:${symbol}:${detail}`);
      }
      const picks = htf.aligned.slice(0, candidateLimit);
      const htfRejected = htf.verdicts.filter(v => !v.aligned);
      if (htfRejected.length) {
        // Classification is semantic, not a "N/3 agree" number: an unknown or
        // unavailable timeframe is recorded as missing evidence, never as a
        // contradiction. Distinct outcome classes are kept apart so infra
        // failure is never counted as a trade rejection:
        //   - "unavailable"/"insufficient_data" (all timeframes unfetchable) → data failure
        //   - any genuine directional contradiction                 → rejection
        const byClass: Record<string, number> = {};
        const dataFailures: string[] = [];
        let directionalRejections = 0;
        for (const v of htfRejected) {
          byClass[v.classification] = (byClass[v.classification] ?? 0) + 1;
          if (v.classification === "unavailable" || v.classification === "insufficient_data") {
            const why = Object.values(v.dataIssues ?? {})[0] ?? v.detail ?? "no_data";
            dataFailures.push(`${v.symbol}:${v.side}:${v.detail ?? "no_data"}`);
            errors.push(`signal_failed:${v.symbol}:htf:${why}`);
            failedCount++;
            continue;
          }
          bump(rejectReasons, `htf:${v.classification}`);
          rejected++;
          directionalRejections++;
        }
        if (directionalRejections > 0) {
          const dir = htfRejected.filter(v => v.classification !== "unavailable" && v.classification !== "insufficient_data");
          errors.push(
            `htf_rejected:${directionalRejections}:` +
            dir.slice(0, 3).map(v => `${v.symbol}:${v.side}:${v.classification}:${v.detail}`).join(" | "),
          );
        }
        if (dataFailures.length) {
          errors.push(
            `htf_data_failure:${dataFailures.length}:` +
            dataFailures.slice(0, 3).join(" | "),
          );
        }
        errors.push(
          "htf_class:" + Object.entries(byClass).map(([k, n]) => `${k}=${n}`).join(","),
        );
      }
      if (htf.deferred.length > 0) {
        // Never inspected inside the HTF budget — deferred, not rejected.
        deferredCount += htf.deferred.length;
        errors.push(`htf_unmeasured:${htf.deferred.length}:budget`);
        for (const sym of htf.deferred) errors.push(`signal_deferred:${sym}:htf:cycle_budget`);
      }
      if (!verdicts.length) {
        // The global "whole universe unavailable" state is only claimed when
        // measured coverage says so. Budget deferrals and partial failures are
        // reported as exactly that instead of being disguised as a total
        // market-data outage.
        if (coverage.globalFailure) {
          errors.push(
            `committee_no_verdicts:market_data_unavailable_for_universe:` +
            `coverage=0/${coverage.attempted}`,
          );
        } else {
          errors.push(
            `committee_no_verdicts:partial_market_data:` +
            `completed=${coverage.completed}:failures=${coverage.dataFailures}` +
            `:deferred=${coverage.deferred}`,
          );
        }
      } else if (!viable.length && waitVerdicts === verdicts.length) {
        errors.push(
          `committee_no_trade:${verdicts.slice(0, 5).map(v => `${v.symbol}:wait:${v.consensusConfidence.toFixed(2)}:${v.agreement.toFixed(2)}`).join(",")}`,
        );
      }

 
 
      // Scale qty so notional fits the user's per-trade cap. The engine
      // targets a $500 notional by default; without this, a $10 cap user
      // would see every generated signal rejected at the risk gate as
      // "position size exceeds max trade size". Take the smaller of the
      // paper-side cap (max_trade_size) and, when routing live, the
      // live per-order cap.
      const capForSize = live
        ? Math.min(Number(settings.max_trade_size ?? 500), Number(settings.live_max_notional_per_order ?? 500))
        : Number(settings.max_trade_size ?? 500);
 
      const toInsert = picks.flatMap(v => {
        let scaledQty = 0;
        if (live && v.consensusDirection === "buy") {
          const targetNotional = Math.max(1, Math.min(capForSize * 0.95, liveStableUsd * 0.9));
          scaledQty = +(targetNotional / v.base.entry).toFixed(6);
        } else if (live && v.consensusDirection === "sell") {
          if (marginVenue) {
            // Short on margin: sized off available margin, not a spot holding.
            const targetNotional = Math.max(1, Math.min(capForSize * 0.95, liveStableUsd * 0.9));
            scaledQty = +(targetNotional / v.base.entry).toFixed(6);
          } else {
            const base = v.symbol.includes("-") ? v.symbol.split("-")[0].toUpperCase() : v.symbol.replace(/USDT$|USD$|USDC$/, "").toUpperCase();
            const byCap = (capForSize * 0.95) / v.base.entry;
            scaledQty = +Math.min((liveBaseAvailable.get(base) ?? 0) * 0.95, byCap).toFixed(6);
          }
 
        } else {
          const targetNotional = Math.max(1, capForSize * 0.95); // 5% headroom under cap
          scaledQty = +(targetNotional / v.base.entry).toFixed(6);
        }
        if (scaledQty <= 0) return [];
        return [{
        user_id: userId,
        symbol: v.symbol, side: v.consensusDirection as "buy" | "sell",
        entry: v.base.entry, stop_loss: v.base.stopLoss, take_profit: v.base.takeProfit,
        qty: scaledQty,
        confidence: v.consensusConfidence,
        reasoning: `AI committee (${v.votes.filter(vt => vt.direction === v.consensusDirection).map(vt => vt.analyst).join(", ")}) — ${v.base.reasoning}`,
        risk_reward: v.base.riskReward, status: "pending",
        expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        time_horizon: v.base.timeHorizon, risk_level: v.base.riskLevel,
        market_regime: v.base.regime,
        indicators: v.base.indicators as unknown as Record<string, never>,
        contributions: [...v.base.contributions, ...v.votes.map(vt => ({
          indicator: `Analyst:${vt.analyst}`, signal: vt.direction === "buy" ? "bullish" : vt.direction === "sell" ? "bearish" : "neutral",
          weight: vt.confidence, detail: vt.rationale,
        }))] as unknown as Record<string, never>,
        risk_factors: v.base.riskFactors as unknown as Record<string, never>,
        }];
      });
      if (toInsert.length) {
        const { data: inserted } = await supabase.from("signals")
          .insert(toInsert).select();
        signals = inserted ?? [];
        errors.push(`committee_generated:${toInsert.length}:${toInsert.map(s => `${s.symbol}:${s.side}:${Number(s.confidence).toFixed(2)}`).join(",")}`);
      } else if (picks.length) {
        // Candidates cleared the committee and HTF but could not be sized.
        const unsized = picks.length - toInsert.length;
        rejected += unsized;
        bump(rejectReasons, "sizing:zero_volume_at_generation");
        errors.push(
          `sizing_no_signal:${unsized}:${picks.slice(0, 3).map(v => `${v.symbol}:${v.consensusDirection}`).join(",")}`,
        );
      }

    } catch (e) {
      errors.push(`committee_gen: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
 
  // `scanned` is set to the committee universe size during generation. When we
  // instead worked from pre-existing pending signals, fall back to their count.
  if (scanned === 0) scanned = signals?.length ?? 0;
  if (signals?.length) errors.push(`signals_in_play:${signals.length}`);
 
  if (!signals || signals.length === 0) {
    await supabase.from("automation_settings")
      .update({ autonomous_last_run_at: new Date().toISOString() })
      .eq("user_id", userId);
    return finish(undefined, live);
  }
 
  const allowedAssets = new Set<string>(settings.allowed_assets ?? []);
  // When the cycle works through signals queued by an EARLIER cycle we never
  // built the broker symbol list, so every broker-discovered symbol (AUD-NZD,
  // NAS100 …) was rejected as `asset_not_allowed`. Load it lazily here so the
  // permission check is identical on both paths.
  if (brokerSymbols.size === 0 && allowedAssets.size > 0) {
    try {
      const { listTradableSymbols } = await import("@/lib/marketdata/service.server");
      const { filterScanUniverse } = await import("@/lib/marketdata/assetClass");
      brokerSymbols = new Set(filterScanUniverse(await listTradableSymbols(supabase, userId)));
    } catch {
      // Non-fatal: fall back to the watchlist-only check.
    }
  }
 
  const minConf = Number(settings.autonomous_min_confidence ?? 0.85);
  const perOrderCap = Number(settings.live_max_notional_per_order ?? 50);
 
  const { evaluateRisk } = await import("@/lib/trading/riskGate.server");
  const { submitOrder } = await import("@/lib/execution/engine.server");
 
  // ---------------------------------------------------------------------
  // Institutional gate: capital-protection policy + strict entry filters.
  // Quality over quantity — a signal must clear EVERY filter to execute.
  // ---------------------------------------------------------------------
  const { evaluateEntry } = await import("@/lib/trading/entryFilters.server");
  const { loadPolicy, dynamicRiskPct } = await import("@/lib/risk/policy.server");
  const { computePositionSize } = await import("@/lib/execution/sizing");
  const liveConnectionId = live ? liveConn?.id : undefined;
  const policy = await loadPolicy(
    supabase, userId,
    live && liveStableUsd > 0 ? liveStableUsd : undefined,
    liveConnectionId,
  );
  if (!policy.tradingAllowed) {
    for (const b of policy.blocks) bump(rejectReasons, `policy:${b}`);
    await supabase.from("automation_settings")
      .update({ autonomous_last_run_at: new Date().toISOString() })
      .eq("user_id", userId);
    return finish(policy.blocks[0], live);
  }
  // A hidden floor here has now silently overridden the user's own Min
  // Confidence setting twice — first at 0.90, then (after being "fixed") at
  // 0.55, both while the code comment claimed to respect the user's value.
  // A 50% slider setting was being clamped up to 55% with zero indication
  // anywhere in the UI. The sanity floor now sits well below anything a user
  // would reasonably choose (guards only against 0 or a data-entry error),
  // so the configured slider value is what actually gates execution.
  const institutionalMinConf = Math.max(
    Number(settings.autonomous_min_confidence ?? 0.65), 0.20,
  );
 
  // Self-learning: automatically review performance every 100 closed trades
  // and re-weight strategies. Best-effort — never blocks execution.
  try {
    const { runLearningEvaluation } = await import("@/lib/learning/evaluator.server");
    const review = await runLearningEvaluation(supabase, userId);
    if (review.ran) errors.push(`learning_review:${review.adjustments.length}_strategies_rescored`);
  } catch (e) {
    errors.push(`learning_review: ${e instanceof Error ? e.message : String(e)}`);
  }
 
  // Strategy lifecycle: re-validate every strategy against recent rolling
  // performance, run weekend retraining, and resolve the live-trading gate.
  let liveGate: { allowed: boolean; reason: string; strategyId: string | null; allocationRiskPct: number } | null = null;
  try {
    const { evaluateAllStrategies, liveTradingGate, runWeekendRetraining } =
      await import("@/lib/lifecycle/engine.server");
    const evals = await evaluateAllStrategies(supabase, userId);
    const moved = evals.filter(e => e.changed);
    if (moved.length) errors.push(`lifecycle:${moved.map(m => `${m.name}:${m.previousState}->${m.state}`).join(",")}`);
    const retrain = await runWeekendRetraining(supabase, userId);
    if (retrain.ran) errors.push(`retrained:${retrain.version}`);
    liveGate = await liveTradingGate(supabase, userId);
    if (!liveGate.allowed) errors.push(`lifecycle_gate:${liveGate.reason}`);
  } catch (e) {
    errors.push(`lifecycle: ${e instanceof Error ? e.message : String(e)}`);
  }
 
  // Portfolio Intelligence layer — health, mode, exposure and the Portfolio
  // Manager AI that sits above every strategy and above the Risk Engine.
  const {
    loadPortfolioContext, evaluateOpportunity, recordDecision, snapshotHealth,
    gradeClosedTrades, runCapitalEngine,
  } = await import("@/lib/portfolioIntel/manager.server");
  let pmCtx: Awaited<ReturnType<typeof loadPortfolioContext>> | null = null;
  try {
    pmCtx = await loadPortfolioContext(
      supabase, userId,
      live && liveStableUsd > 0 ? liveStableUsd : undefined,
      liveConnectionId,
    );
    await snapshotHealth(supabase, userId, pmCtx);
    errors.push(`portfolio_health:${pmCtx.health.healthScore}:${pmCtx.mode}`);
    // Why the Portfolio Manager is as strict as it is right now. Without this
    // the cycle only reported "below_pm_min_score" with no way to see that the
    // mode (and therefore the threshold) was elevated by drawdown.
    errors.push(
      `pm_constraints:mode=${pmCtx.mode}:min_score=${pmCtx.constraints.minScore}` +
      `:min_conf=${pmCtx.constraints.minConfidence.toFixed(2)}` +
      `:size_x${pmCtx.constraints.sizeMultiplier}` +
      `:dd=${(pmCtx.drawdownPct * 100).toFixed(2)}%:equity=${pmCtx.equity.toFixed(2)}`,
    );
    const capital = await runCapitalEngine(supabase, userId);
    if (capital.ran) errors.push(`capital_engine:v${capital.version}_shadow`);
    await gradeClosedTrades(supabase, userId);
  } catch (e) {
    errors.push(`portfolio_intel: ${e instanceof Error ? e.message : String(e)}`);
  }
 
  // User-configured trade volume. "fixed" sends exactly the volume/lot the
  // user set; "auto" keeps risk-based dynamic sizing.
  const volumeMode = String(settings.trade_volume_mode ?? "auto");
  const fixedVolume = Number(settings.fixed_trade_volume ?? 0);

  // Per-cycle execution funnel. Purely observational: every gate keeps its own
  // rule, this only records which gate a candidate died at (the FIRST one, since
  // each rejection short-circuits with `continue`) so the real bottleneck is
  // visible instead of inferred.
  const funnel = {
    candidates: signals.length,
    precheck: 0, entry_filter: 0, lifecycle: 0,
    portfolio: 0, risk: 0, execution_intel: 0, executed: 0,
  };
  const gateOut = (symbol: string, gate: string, detail: string) => {
    errors.push(`first_gate:${symbol}:${gate}:${detail}`);
  };

  let slots = capacity;
  for (let signalIndex = 0; signalIndex < signals.length; signalIndex++) {
    const sig = signals[signalIndex];
    if (outOfBudget()) {
      const pending = signals.slice(signalIndex);
      deferredCount += pending.length;
      // Leave these signals pending for the next bounded cycle rather than
      // falsely rejecting valid setups because broker history was slow.
      for (const p of pending) {
        errors.push(`signal_deferred:${p.symbol}:cycle_budget`);
      }
      break;
    }
    // Per-signal error boundary: one bad symbol must never abort the cycle or
    // discard results already produced by other symbols.
    let stage = "precheck";
    try {
    if (slots === 0) {
      bump(rejectReasons, "no_open_slots"); rejected++;
      gateOut(sig.symbol, "precheck", "no_open_slots");
      continue;
    }
    if (Number(sig.confidence) < minConf) {
      bump(rejectReasons, "below_min_confidence"); rejected++;
      gateOut(sig.symbol, "precheck", `confidence ${Number(sig.confidence).toFixed(2)} < ${minConf}`);
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    // A symbol is permitted if it is on the watchlist OR the connected broker
    // lists it as tradable — otherwise broker-discovered signals would always
    // be rejected as "asset_not_allowed".
    if (allowedAssets.size > 0 && !allowedAssets.has(sig.symbol) && !brokerSymbols.has(sig.symbol)) {
      bump(rejectReasons, "asset_not_allowed"); rejected++;
      gateOut(sig.symbol, "precheck", "asset_not_allowed");
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    const qty = Number(sig.qty);
    const entry = Number(sig.entry);
    const side = sig.side as "buy" | "sell";
    const notional = qty * entry;
 
    if (live && notional > perOrderCap) {
      bump(rejectReasons, "over_live_notional_cap"); rejected++;
      gateOut(sig.symbol, "precheck", `notional ${notional.toFixed(2)} > cap ${perOrderCap}`);
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    funnel.precheck++;
 
    // Institutional entry gate — multi-timeframe, regime, structure, news.
    stage = "entry_filter";
    let execQty = qty;
    let execStop = Number(sig.stop_loss);
    let execTp = Number(sig.take_profit);
    let entryEval: Awaited<ReturnType<typeof evaluateEntry>> | null = null;
    try {
      entryEval = await evaluateEntry(supabase, sig.symbol, side, {
        minConfidence: institutionalMinConf,
        minRR: Number(settings.min_risk_reward ?? 2),
        maxRR: Number(settings.max_risk_reward ?? 4),
        maxSpreadBps: Number(settings.max_spread_bps ?? 30),
        requireMtf: settings.mtf_confirmation_required !== false,
        newsFilterEnabled: settings.news_filter_enabled !== false,
      }, userId);
    } catch (e) {
      errors.push(`entry_gate:${sig.symbol}:${e instanceof Error ? e.message : String(e)}`);
    }
    // Market-data or entry-analysis failure must fail closed. Previously a
    // thrown entry evaluation left `entryEval` null and the signal continued
    // toward the broker without having passed the institutional entry gate.
    if (!entryEval) {
      bump(rejectReasons, "entry_filter:evaluation_unavailable");
      rejected++;
      gateOut(sig.symbol, "entry_filter", "evaluation_unavailable");
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    if (entryEval && !entryEval.approved) {
      bump(rejectReasons, `entry_filter:${entryEval.rejections[0] ?? "failed"}`);
      rejected++;
      gateOut(sig.symbol, "entry_filter", entryEval.rejections[0] ?? "failed");
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    if (entryEval?.frame) {
      execStop = entryEval.frame.stopLoss;
      execTp = entryEval.frame.takeProfit;
      const { riskPct, notes } = dynamicRiskPct(policy, {
        confidence: entryEval.confidence,
        regimeTradable: entryEval.regime.tradable,
        trendStrength: entryEval.regime.trendStrength,
      });
      const sized = computePositionSize({
        equity: policy.equity > 0 ? policy.equity : notional,
        freeMargin: policy.equity,
        riskPct,
        entryPrice: entry,
        stopLoss: execStop,
        spec: { volumeMin: 0, volumeMax: Number.MAX_SAFE_INTEGER, volumeStep: 0, contractSize: 1 },
        marginBufferPct: 0,
      });
      if (sized.volume > 0 && Number.isFinite(sized.volume)) {
        const capNotional = live
          ? Math.min(Number(settings.max_trade_size ?? 500), perOrderCap)
          : Number(settings.max_trade_size ?? 500);
        execQty = +Math.min(sized.volume, capNotional / entry, qty > 0 ? Math.max(qty, sized.volume) : sized.volume).toFixed(8);
      }
      errors.push(`sizing:${sig.symbol}:${(riskPct * 100).toFixed(2)}%:${notes[0] ?? ""}`);
      await supabase.from("signals").update({
        stop_loss: execStop, take_profit: execTp, qty: execQty,
        confidence: entryEval.confidence,
        reasoning: entryEval.reasoning,
        market_regime: entryEval.regime.regime,
      }).eq("id", sig.id);
    }
    if (!(execQty > 0)) {
      bump(rejectReasons, "sizing:zero_volume"); rejected++;
      gateOut(sig.symbol, "entry_filter", "sizing_zero_volume");
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    funnel.entry_filter++;
 
    // ---------------------------------------------------------------
    // Stage 2 — Strategy lifecycle gate.
    // No real order unless a strategy is LIVE, scored ≥80, free of drift and
    // still profitable in its most recent validation window. Non-qualifying
    // live signals are recorded as shadow trades so the strategy keeps
    // accumulating evidence without risking capital.
    // ---------------------------------------------------------------
    if (live && liveGate && !liveGate.allowed) {
      bump(rejectReasons, `lifecycle_gate:${liveGate.reason}`);
      rejected++;
      gateOut(sig.symbol, "lifecycle_gate", liveGate.reason);
      await supabase.from("shadow_trades").insert({
        user_id: userId,
        strategy_id: liveGate.strategyId,
        symbol: sig.symbol, side,
        entry_price: entry, stop_loss: execStop, take_profit: execTp,
        qty: execQty, confidence: entryEval?.confidence ?? Number(sig.confidence),
        market_regime: entryEval?.regime.regime ?? sig.market_regime,
        mode: "shadow", status: "open",
        indicators: (sig.indicators ?? {}) as never,
        features: { source: "autopilot", gate: liveGate.reason } as never,
      });
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    funnel.lifecycle++;
 
    // ---------------------------------------------------------------
    // Stage 3 — Portfolio Manager AI.
    // Scores the opportunity 0-100 across return, expectancy, regime,
    // correlation, exposure, cost, flow and strategy quality, then allocates
    // a share of the risk budget. Below the minimum score the trade dies here.
    // ---------------------------------------------------------------
    stage = "portfolio_manager";
    if (pmCtx && settings.pm_enabled !== false) {
      try {
        const verdict = await evaluateOpportunity(supabase, userId, pmCtx, {
          signalId: sig.id,
          strategyId: liveGate?.strategyId ?? null,
          symbol: sig.symbol, side, entry,
          stopLoss: execStop, takeProfit: execTp,
          confidence: entryEval?.confidence ?? Number(sig.confidence),
        });
        await recordDecision(supabase, userId, {
          signalId: sig.id, strategyId: liveGate?.strategyId ?? null,
          symbol: sig.symbol, side, entry, stopLoss: execStop, takeProfit: execTp,
          confidence: entryEval?.confidence ?? Number(sig.confidence),
        }, verdict);
        if (!verdict.approved) {
          bump(rejectReasons, `portfolio_manager:${verdict.rejectReason ?? "rejected"}`);
          rejected++;
          // Full evidence: the verdict, the threshold it missed, and the
          // component breakdown that produced the score.
          gateOut(
            sig.symbol, "portfolio_manager",
            `${verdict.rejectReason ?? "rejected"} score=${verdict.score}/${pmCtx.constraints.minScore} ` +
            `conf=${(entryEval?.confidence ?? Number(sig.confidence)).toFixed(2)}/${pmCtx.constraints.minConfidence.toFixed(2)} ` +
            `mode=${verdict.mode} components=${Object.entries(verdict.components).map(([k, v]) => `${k}:${v}`).join("|")}`,
          );
          await supabase.from("signals").update({
            status: "rejected", resolved_at: new Date().toISOString(),
          }).eq("id", sig.id);
          continue;
        }
        // Allocation → position size. Risk % of equity over the stop distance.
        const stopDist = Math.abs(entry - execStop);
        if (stopDist > 0 && pmCtx.equity > 0) {
          const allocQty = (pmCtx.equity * (verdict.riskPct / 100)) / stopDist;
          if (allocQty > 0 && Number.isFinite(allocQty)) {
            execQty = +Math.min(execQty, allocQty).toFixed(8);
          }
        }
        errors.push(`pm:${sig.symbol}:score_${verdict.score.toFixed(1)}:alloc_${(verdict.allocation * 100).toFixed(0)}%:${verdict.mode}`);
        if (!(execQty > 0)) {
          bump(rejectReasons, "portfolio_manager:zero_size_after_allocation"); rejected++;
          gateOut(sig.symbol, "portfolio_manager", "zero_size_after_allocation");
          await supabase.from("signals").update({
            status: "rejected", resolved_at: new Date().toISOString(),
          }).eq("id", sig.id);
          continue;
        }
      } catch (e) {
        errors.push(`portfolio_manager: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    funnel.portfolio++;

    // User-configured fixed volume overrides dynamic sizing (risk gate and
    // notional caps below still apply — the size is user-chosen, not unchecked).
    if (volumeMode === "fixed" && fixedVolume > 0) {
      execQty = fixedVolume;
      errors.push(`sizing:${sig.symbol}:fixed_volume=${fixedVolume}`);
    }

    // ---------------------------------------------------------------
    // Stage 4 — Risk Engine.
    // ---------------------------------------------------------------
    stage = "risk_gate";
    const decision = await evaluateRisk(supabase, userId, {
      symbol: sig.symbol, side, qty: execQty, entry,
      stopLoss: execStop, takeProfit: execTp,
      confidence: entryEval?.confidence ?? Number(sig.confidence),
      equity: live && liveStableUsd > 0 ? liveStableUsd : undefined,
      connectionId: liveConnectionId,
    });
    if (!decision.allowed) {
      bump(rejectReasons, `risk_gate:${decision.reason ?? "rejected"}`);
      rejected++;
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      await supabase.from("audit_log").insert({
        user_id: userId, action: "autonomous.reject_by_risk",
        entity: "signals", entity_id: sig.id,
        payload: { reason: decision.reason },
      });
      continue;
    }
 
    // ---------------------------------------------------------------
    // Stage 5 — Execution Intelligence (final decision maker).
    // Entry timing, multi-timeframe confirmation, order flow, volatility,
    // session quality, smart order type and dynamic SL/TP. Anything below the
    // confidence floor is downgraded to a shadow trade instead of an order.
    // ---------------------------------------------------------------
    stage = "execution_intel";
    let execOrderType: "market" | "limit" | "stop" = "market";
    let execLimitPrice: number | null = null;
    let execGrade: string | null = null;
    let execScore: number | null = null;
    try {
      const { evaluateExecution } = await import("@/lib/execution/executionIntel.server");
      const xi = await evaluateExecution(supabase, userId, {
        symbol: sig.symbol, side, entry,
        signalId: sig.id, strategyId: liveGate?.strategyId ?? null,
      });
      if (!xi.approved) {
        bump(rejectReasons, `execution_intel:${xi.rejections[0] ?? xi.action}`);
        rejected++;
        if (xi.shadowOnly) {
          await supabase.from("shadow_trades").insert({
            user_id: userId, strategy_id: liveGate?.strategyId ?? null,
            symbol: sig.symbol, side,
            entry_price: entry, stop_loss: xi.stopLoss ?? execStop,
            take_profit: xi.takeProfit ?? execTp,
            qty: execQty, confidence: xi.confidence,
            market_regime: entryEval?.regime.regime ?? sig.market_regime,
            mode: "shadow", status: "open",
            indicators: (sig.indicators ?? {}) as never,
            features: { source: "execution_intel", grade: xi.grade, score: xi.score } as never,
          });
        }
        await supabase.from("signals").update({
          status: "rejected", resolved_at: new Date().toISOString(),
        }).eq("id", sig.id);
        continue;
      }
      if (xi.stopLoss != null && xi.takeProfit != null) {
        execStop = xi.stopLoss;
        execTp = xi.takeProfit;
      }
      execOrderType = xi.orderType;
      execLimitPrice = xi.limitPrice;
      execGrade = xi.grade;
      execScore = xi.score;
      errors.push(`exec_intel:${sig.symbol}:${xi.grade}:${xi.score.toFixed(1)}:${xi.orderType}`);
      await supabase.from("signals").update({
        stop_loss: execStop, take_profit: execTp,
        reasoning: xi.reasoning, confidence: xi.confidence,
      }).eq("id", sig.id);
    } catch (e) {
      errors.push(`execution_intel: ${e instanceof Error ? e.message : String(e)}`);
    }
 
    // Execute
    stage = "submit_order";
    try {
      const result = await submitOrder(supabase, userId, {
        symbol: sig.symbol, side, qty: execQty,
        orderType: execOrderType === "market" ? "market" : "limit",
        limitPrice: execLimitPrice ?? undefined,
        stopLoss: execStop, takeProfit: execTp,
        signalId: sig.id,
        connectionId: liveConn?.id ?? null, live,
      });
 
      if (result.status === "rejected" || result.status === "error") {
        bump(rejectReasons, `exec:${result.message ?? result.status}`);
        rejected++;
        await supabase.from("signals").update({
          status: "rejected", resolved_at: new Date().toISOString(),
        }).eq("id", sig.id);
        continue;
      }
 
      // Position bookkeeping. A SELL only opens a SHORT on a venue that can
      // actually short (margin). On a spot venue a SELL is a disposal of the
      // base asset: it reduces/closes an existing long, and must never create
      // a synthetic short row.
      const spotSell = side === "sell" && live && !marginVenue;
      const filledPrice = result.filledPrice ?? entry;
      const filledQty = result.filledQty;
      let positionId: string | null = null;
      if (spotSell) {
        const { data: openLong } = await supabase.from("positions")
          .select("id,qty").eq("user_id", userId).eq("symbol", sig.symbol)
          .eq("side", "long").eq("status", "open")
          .order("opened_at", { ascending: true }).limit(1).maybeSingle();
        if (openLong?.id) {
          const remaining = +(Number(openLong.qty) - filledQty).toFixed(8);
          positionId = openLong.id as string;
          await supabase.from("positions").update(
            remaining > 0
              ? { qty: remaining }
              : { qty: 0, status: "closed", closed_at: new Date().toISOString() },
          ).eq("id", openLong.id);
        }
        // No tracked long: the venue holding was acquired outside the app.
        // Record the order only — do not fabricate a short position.
      } else if (paperAcct) {
        const { data: pos } = await supabase.from("positions").insert({
          user_id: userId, account_id: paperAcct.id,
          symbol: sig.symbol, side: side === "buy" ? "long" : "short",
          qty: filledQty, original_qty: qty, filled_qty: filledQty,
          avg_entry: filledPrice,
          stop_loss: execStop, take_profit: execTp,
          trailing_stop_pct: 0.015, status: "open",
          ai_reasoning: sig.reasoning, ai_confidence: sig.confidence,
          ai_regime: sig.market_regime,
          strategy_id: liveGate?.strategyId ?? null,
          connection_id: result.isLive ? liveConnectionId ?? null : null,
          external_position_id: result.isLive ? result.positionId : null,
        }).select().single();
        positionId = (pos?.id as string) ?? null;
      }
      if (positionId) {
        await supabase.from("orders").update({ position_id: positionId })
          .eq("id", result.orderId);
      }
      if (paperAcct) {

        if (!result.isLive) {
          await supabase.from("paper_accounts").update({
            cash_balance: Number(paperAcct.cash_balance) - filledPrice * filledQty - result.fees,
          }).eq("id", paperAcct.id);
          paperAcct.cash_balance = Number(paperAcct.cash_balance) - filledPrice * filledQty - result.fees;
        }
      }
 
      await supabase.from("signals").update({
        status: "executed", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
 
      await supabase.from("audit_log").insert({
        user_id: userId, action: "autonomous.execute",
        entity: "signals", entity_id: sig.id,
        payload: {
          qty, filledPrice: result.filledPrice, filledQty: result.filledQty,
          fees: result.fees, live: result.isLive, trigger,
        },
      });
 
      executed++;
      slots--;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`signal_failed:${sig.symbol}:submit_order:${msg}`);
      if (live && liveConn && isRegionalConnectivityError(e)) {
        await markConnectionRegionBlocked(supabase, liveConn.id, userId, msg);
        await supabase.from("automation_settings").update({
          live_kill_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          live_kill_reason: BYBIT_REGION_BLOCKED_REASON,
        }).eq("user_id", userId);
        bump(rejectReasons, "exec:region_blocked");
      } else {
        bump(rejectReasons, "exec:exception");
      }
      // Infrastructure failure, not a risk verdict — counted separately so a
      // provider outage cannot masquerade as the safety gates rejecting trades.
      failedCount++;
    }
    } catch (e) {
      // Isolated failure — record it and keep evaluating the other signals.
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`signal_failed:${sig?.symbol ?? "unknown"}:${stage}:${msg}`);
      bump(rejectReasons, `signal_failed:${stage}`);
      failedCount++;
    }
  }
 
  await supabase.from("automation_settings")
    .update({ autonomous_last_run_at: new Date().toISOString() })
    .eq("user_id", userId);
 
  return finish(undefined, live);
}
 
/** Guaranteed cleanup boundary: no unexpected provider/database exception may
 * leave an autonomous_runs row open and block every subsequent cron tick. */
export async function runAutonomousCycleFor(
  supabase: SupabaseClient,
  userId: string,
  trigger: "manual" | "cron" | "signal",
): Promise<CycleResult> {
  // Lock ownership: the watchdog may only close the run row this invocation
  // created. Closing "the newest open row" could terminate a genuinely active
  // concurrent cycle belonging to another invocation.
  const ownership: { runId: string | null; abandoned?: boolean } = { runId: null };
  try {
    // Two-stage watchdog.
    //
    // Stage 1 (soft, 42s): cancel the cycle's AbortController. The engine stops
    // starting new provider work, in-flight requests are aborted, and the cycle
    // finishes normally with whatever it measured — a graceful stop, not a kill.
    //
    // Stage 2 (hard, 50s): only if the graceful stop itself did not settle. It
    // closes OUR run row (scoped by run id AND still-open) and marks the cycle
    // abandoned, so any late completion never rewrites it. It can never steal a
    // healthy concurrent cycle's lock.
    const controller = new AbortController();
    let softTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    softTimer = setTimeout(() => controller.abort(), 42_000);
    const watchdog = new Promise<CycleResult>(resolve => {
      hardTimer = setTimeout(async () => {
        ownership.abandoned = true;
        const note = "cycle_watchdog_timeout:graceful_cancel_did_not_settle";
        const finishedAt = new Date().toISOString();
        if (ownership.runId) {
          await supabase.from("autonomous_runs").update({
            finished_at: finishedAt, errors: [note],
          }).eq("id", ownership.runId).is("finished_at", null);
        }
        resolve({
          runId: String(ownership.runId ?? "watchdog"),
          scanned: 0, executed: 0, rejected: 0, deferred: 0, failed: 0,
          rejectReasons: {},
          errors: [note],
          skipped: "cycle_watchdog_timeout",
        });
      }, 50_000);
    });
    try {
      return await Promise.race([
        runAutonomousCycleCore(supabase, userId, trigger, ownership, controller.signal),
        watchdog,
      ]);
    } finally {
      if (softTimer) clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
      controller.abort();
    }


  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    const { data: settings } = await supabase.from("automation_settings")
      .select("autonomous_live_enabled,autonomous_default_connection_id")
      .eq("user_id", userId).maybeSingle();
    const live = Boolean(settings?.autonomous_live_enabled)
      && Boolean(settings?.autonomous_default_connection_id);
    const runId = String(ownership.runId ?? "fatal-cycle");
    if (ownership.runId) {
      await supabase.from("autonomous_runs").update({
        finished_at: finishedAt,
        live,
        errors: [`fatal_cycle_error:${message}`],
      }).eq("id", ownership.runId).is("finished_at", null);
    }
    return {
      runId, scanned: 0, executed: 0, rejected: 0, deferred: 0, failed: 1,
      rejectReasons: {}, errors: [`fatal_cycle_error:${message}`],
      skipped: "fatal_cycle_error",
    };
  }
}
 
// ---------------------------------------------------------------------------
// Server functions
// ---------------------------------------------------------------------------
export const runAutonomousCycle = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    return runAutonomousCycleFor(context.supabase, context.userId, "manual");
  });
 
const AutonomousSettingsSchema = z.object({
  mode: z.enum(["manual", "assisted", "autonomous"]),
  autonomous_min_confidence: z.number().min(0.4).max(0.99),
  exec_min_confidence: z.number().min(0.4).max(0.99),
  autonomous_max_open_positions: z.number().int().min(1).max(20),
  autonomous_cooldown_seconds: z.number().int().min(30).max(3600),
  autonomous_max_consecutive_losses: z.number().int().min(1).max(10),
  autonomous_live_enabled: z.boolean(),
  autonomous_default_connection_id: z.string().uuid().nullable(),
  trade_volume_mode: z.enum(["auto", "fixed"]).optional(),
  fixed_trade_volume: z.number().min(0.001).max(1000).optional(),
});
 
export const updateAutonomousSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AutonomousSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    // If enabling autonomous_live, require the connection to be trading-enabled
    if (data.autonomous_live_enabled) {
      if (!data.autonomous_default_connection_id) {
        throw new Error("Choose a live connection before enabling autonomous live trading.");
      }
      const { data: c } = await context.supabase.from("exchange_connections")
        .select("trading_enabled,status,connector_id")
        .eq("id", data.autonomous_default_connection_id)
        .eq("user_id", context.userId).maybeSingle();
      if (!c || !c.trading_enabled || c.status !== "connected" || c.connector_id === "paper") {
        throw new Error("Selected connection is not activated for live trading.");
      }
    }
    await context.supabase.from("automation_settings").update({
      mode: data.mode,
      autonomous_min_confidence: data.autonomous_min_confidence,
      exec_min_confidence: data.exec_min_confidence,
      autonomous_max_open_positions: data.autonomous_max_open_positions,
      autonomous_cooldown_seconds: data.autonomous_cooldown_seconds,
      autonomous_max_consecutive_losses: data.autonomous_max_consecutive_losses,
      autonomous_live_enabled: data.autonomous_live_enabled,
      autonomous_default_connection_id: data.autonomous_default_connection_id,
      ...(data.trade_volume_mode ? { trade_volume_mode: data.trade_volume_mode } : {}),
      ...(data.fixed_trade_volume !== undefined ? { fixed_trade_volume: data.fixed_trade_volume } : {}),
    }).eq("user_id", context.userId);
    await context.supabase.from("audit_log").insert({
      user_id: context.userId, action: "autonomous.settings_update",
      entity: "automation_settings", entity_id: null,
      payload: data as unknown as Record<string, never>,
    });
    return { ok: true };
  });
 
export const getAutonomousStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [settingsRes, runsRes, openRes, connsRes] = await Promise.all([
      context.supabase.from("automation_settings").select("*")
        .eq("user_id", context.userId).maybeSingle(),
      context.supabase.from("autonomous_runs").select("*")
        .eq("user_id", context.userId).order("started_at", { ascending: false }).limit(25),
      context.supabase.from("positions").select("id", { count: "exact", head: true })
        .eq("user_id", context.userId).eq("status", "open"),
      context.supabase.from("exchange_connections")
        .select("id,label,connector_id,trading_enabled,status")
        .eq("user_id", context.userId),
    ]);
    const { loadRejectionBreakdown, loadHtfSeverityBreakdown } =
      await import("@/lib/autonomous/rejectionStats.server");
    const [rejectionBreakdown, htfSeverity] = await Promise.all([
      loadRejectionBreakdown(context.supabase, context.userId, 7),
      loadHtfSeverityBreakdown(context.supabase, context.userId, 7),
    ]);
    return {
      settings: settingsRes.data,
      runs: runsRes.data ?? [],
      openPositions: openRes.count ?? 0,
      connections: connsRes.data ?? [],
      rejectionBreakdown,
      htfSeverity,
    };
  });
 
