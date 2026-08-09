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
  rejected: number;
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
export async function runAutonomousCycleFor(
  supabase: SupabaseClient,
  userId: string,
  trigger: "manual" | "cron" | "signal",
): Promise<CycleResult> {
  const rejectReasons: Record<string, number> = {};
  const errors: string[] = [];
  let scanned = 0;
  // Symbols the connected broker actually lists as tradable. Populated during
  // signal generation; used to widen the execution allow-list beyond the
  // static `allowed_assets` watchlist.
  let brokerSymbols = new Set<string>();
  let executed = 0;
  let rejected = 0;

  const startedAt = new Date().toISOString();
  const { data: runRow } = await supabase.from("autonomous_runs").insert({
    user_id: userId, started_at: startedAt, trigger, live: false,
  }).select().single();
  const runId = runRow?.id as string;

  const finish = async (skipped?: string, live = false) => {
    const runErrors = skipped ? [...errors, withDetail("skipped", skipped)] : errors;
    await supabase.from("autonomous_runs").update({
      finished_at: new Date().toISOString(),
      signals_scanned: scanned, signals_executed: executed, signals_rejected: rejected,
      reject_reasons: rejectReasons, errors: runErrors, live,
    }).eq("id", runId);
    return { runId, scanned, executed, rejected, rejectReasons, errors: runErrors, skipped };
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
      const { filterScanUniverse } = await import("@/lib/marketdata/assetClass");
      // The scan universe is the UNION of the user's watchlist and the
      // connected broker's real tradable list, restricted to the instrument
      // families this engine is calibrated for: crypto, major forex and index
      // CFDs. Individual equities / international share CFDs (BKNGNAS, AAPL,
      // SAP.de …) are dropped outright rather than patched name-by-name.
      const rawTradable = await listTradableSymbols(supabase, userId);
      const tradable = filterScanUniverse(rawTradable);
      brokerSymbols = new Set(tradable);
      const universe = Array.from(new Set([
        ...filterScanUniverse(settings.allowed_assets ?? []),
        ...tradable.slice(0, 60),
      ]));
      // "scanned" now means symbols evaluated by the AI committee — the
      // honest metric. Signals produced are reported separately below.
      scanned = universe.length;
      errors.push(
        `universe:${universe.length}:watchlist=${(settings.allowed_assets ?? []).length}` +
        `:broker=${tradable.length}/${rawTradable.length}(non-equity)`,
      );
      const verdicts = await runCommittee(supabase, universe, userId);
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
      const viable = verdicts
        .filter(v => v.consensusDirection !== "wait"
          && canFundVerdict(v.symbol, v.consensusDirection)
          && v.consensusConfidence >= minConfForGen
          && v.agreement >= 1 / 2
          // The latest production failure promoted a unanimous bearish vote
          // whose underlying 15m MACD histogram was flat. It was the only HTF
          // candidate and immediately failed the exact same check in
          // evaluateEntry. Apply that authoritative momentum rule here so the
          // search continues to the next instrument instead of starving.
          && v.entryMomentumConfirmed
          && v.base.regime !== "low_volatility"
          && v.base.regime !== "extreme_risk");
      // Counter-trend candidates are guaranteed to fail the entry gate's
      // higher-timeframe alignment check, so they must not consume the batch.
      // This now uses REAL 1D/4H/1H broker candles (the committee's resampled
      // 15m proxy silently degraded to an entry-timeframe bias and let
      // counter-trend ideas through).
      const { filterHtfAligned } = await import("@/lib/trading/htfFilter.server");
      const htf = await filterHtfAligned(
        supabase,
        viable,
        v => v.consensusDirection as "buy" | "sell",
        userId,
        // Search the full momentum-qualified set (bounded to the calibrated
        // universe) rather than only the first 24 ranked names. A single
        // market-wide direction conflict must not end a 72-symbol cycle.
        Math.min(viable.length, 60),
      );
      const picks = htf.aligned.slice(0, candidateLimit);
      if (!picks.length && viable.length) {
        errors.push(
          `htf_conflict:${viable.length}_candidates_counter_trend:` +
          htf.verdicts.slice(0, 3).map(v => `${v.symbol}:${v.side}:${v.detail}`).join(" | "),
        );
      }
      if (!viable.length && verdicts.length) {
        const momentumMisses = verdicts
          .filter(v => v.consensusDirection !== "wait" && !v.entryMomentumConfirmed)
          .slice(0, 3)
          .map(v => `${v.symbol}:${v.consensusDirection}:${v.entryMomentumDetail}`)
          .join(" | ");
        errors.push(`entry_momentum_no_candidates:${momentumMisses || "no_directional_consensus"}`);
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
      } else {
        errors.push(`committee_no_trade:${verdicts.slice(0, 5).map(v => `${v.symbol}:${v.consensusDirection}:${v.consensusConfidence.toFixed(2)}:${v.agreement.toFixed(2)}`).join(",") || "no_verdicts"}`);
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
  const policy = await loadPolicy(supabase, userId, live && liveStableUsd > 0 ? liveStableUsd : undefined);
  if (!policy.tradingAllowed) {
    for (const b of policy.blocks) bump(rejectReasons, `policy:${b}`);
    await supabase.from("automation_settings")
      .update({ autonomous_last_run_at: new Date().toISOString() })
      .eq("user_id", userId);
    return finish(policy.blocks[0], live);
  }
  const institutionalMinConf = Math.max(
    Number(settings.autonomous_min_confidence ?? 0.9), 0.9,
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
    pmCtx = await loadPortfolioContext(supabase, userId, live && liveStableUsd > 0 ? liveStableUsd : undefined);
    await snapshotHealth(supabase, userId, pmCtx);
    errors.push(`portfolio_health:${pmCtx.health.healthScore}:${pmCtx.mode}`);
    const capital = await runCapitalEngine(supabase, userId);
    if (capital.ran) errors.push(`capital_engine:v${capital.version}_shadow`);
    await gradeClosedTrades(supabase, userId);
  } catch (e) {
    errors.push(`portfolio_intel: ${e instanceof Error ? e.message : String(e)}`);
  }

  let slots = capacity;
  for (const sig of signals) {
    if (slots === 0) { bump(rejectReasons, "no_open_slots"); rejected++; continue; }
    if (Number(sig.confidence) < minConf) {
      bump(rejectReasons, "below_min_confidence"); rejected++;
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
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }

    // Institutional entry gate — multi-timeframe, regime, structure, news.
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
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }
    if (entryEval && !entryEval.approved) {
      bump(rejectReasons, `entry_filter:${entryEval.rejections[0] ?? "failed"}`);
      rejected++;
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
      await supabase.from("signals").update({
        status: "rejected", resolved_at: new Date().toISOString(),
      }).eq("id", sig.id);
      continue;
    }

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

    // ---------------------------------------------------------------
    // Stage 3 — Portfolio Manager AI.
    // Scores the opportunity 0-100 across return, expectancy, regime,
    // correlation, exposure, cost, flow and strategy quality, then allocates
    // a share of the risk budget. Below the minimum score the trade dies here.
    // ---------------------------------------------------------------
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
          await supabase.from("signals").update({
            status: "rejected", resolved_at: new Date().toISOString(),
          }).eq("id", sig.id);
          continue;
        }
      } catch (e) {
        errors.push(`portfolio_manager: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ---------------------------------------------------------------
    // Stage 4 — Risk Engine.
    // ---------------------------------------------------------------
    const decision = await evaluateRisk(supabase, userId, {
      symbol: sig.symbol, side, qty: execQty, entry,
      stopLoss: execStop, takeProfit: execTp,
      confidence: entryEval?.confidence ?? Number(sig.confidence),
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

      // Create position (mirrors approveSignalV2)
      if (paperAcct) {
        const filledPrice = result.filledPrice ?? entry;
        const filledQty = result.filledQty;
        const { data: pos } = await supabase.from("positions").insert({
          user_id: userId, account_id: paperAcct.id,
          symbol: sig.symbol, side: sig.side === "buy" ? "long" : "short",
          qty: filledQty, original_qty: qty, filled_qty: filledQty,
          avg_entry: filledPrice,
          stop_loss: sig.stop_loss, take_profit: sig.take_profit,
          trailing_stop_pct: 0.015, status: "open",
          ai_reasoning: sig.reasoning, ai_confidence: sig.confidence,
          ai_regime: sig.market_regime,
          strategy_id: liveGate?.strategyId ?? null,
        }).select().single();
        await supabase.from("orders").update({ position_id: pos?.id })
          .eq("id", result.orderId);
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
      errors.push(msg);
      bump(rejectReasons, "exception");
      rejected++;
    }
  }

  await supabase.from("automation_settings")
    .update({ autonomous_last_run_at: new Date().toISOString() })
    .eq("user_id", userId);

  return finish(undefined, live);
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
  autonomous_min_confidence: z.number().min(0.5).max(0.99),
  autonomous_max_open_positions: z.number().int().min(1).max(20),
  autonomous_cooldown_seconds: z.number().int().min(30).max(3600),
  autonomous_max_consecutive_losses: z.number().int().min(1).max(10),
  autonomous_live_enabled: z.boolean(),
  autonomous_default_connection_id: z.string().uuid().nullable(),
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
      autonomous_max_open_positions: data.autonomous_max_open_positions,
      autonomous_cooldown_seconds: data.autonomous_cooldown_seconds,
      autonomous_max_consecutive_losses: data.autonomous_max_consecutive_losses,
      autonomous_live_enabled: data.autonomous_live_enabled,
      autonomous_default_connection_id: data.autonomous_default_connection_id,
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
    return {
      settings: settingsRes.data,
      runs: runsRes.data ?? [],
      openPositions: openRes.count ?? 0,
      connections: connsRes.data ?? [],
    };
  });
