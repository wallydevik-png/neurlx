// Execution Intelligence Engine (server side).
//
// Sits between Portfolio Intelligence and Broker Execution and is the final
// decision maker before any live order:
//
//   Strategy → Lifecycle → Portfolio Manager → Risk Engine → **Execution AI** → Broker
//
// It answers three questions for every approved opportunity:
//   1. Is *now* the right moment to enter? (Entry Timing AI, 0-100)
//   2. How should the order be placed? (market / limit / stop, price)
//   3. Where do stop, target, trailing and partials go? (ATR + structure)
//
// Anything scoring below the configured confidence floor (default 90%) is
// downgraded to a shadow trade — recorded, never sent to the broker.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Candle } from "@/lib/analysis/indicators";
import { adx } from "@/lib/analysis/institutional";
import { fetchCandles } from "@/lib/marketdata/service.server";
import { checkEventWindow } from "@/lib/analysis/eventWindow";
import {
  DEFAULT_WEIGHTS, MTF_ORDER, biasFromCandles, chooseOrderType, classifyEntryTiming,
  classifySession, dynamicFrame, evaluateEntryTiming, expectedValueR, gradeFor,
  managementPlan, multiTimeframeConfirmation, normalizeWeights, reoptimizeWeights,
  welchTTest, winProbability,
  type Bias, type EntryWeights, type MemorySample, type SessionStat, type Side,
  type Timeframe, type TradingSession,
} from "./entryAI";

export const LEARNING_INTERVAL = 50;

export interface ExecutionConfig {
  enabled: boolean;
  minConfidence: number;      // 0..1
  sessionFilterEnabled: boolean;
  newsFilterEnabled: boolean;
  maxSpreadBps: number;
  minRR: number;
  maxRR: number;
  weights: EntryWeights;
  modelVersion: number;
}

export interface ExecutionVerdict {
  symbol: string;
  side: Side;
  approved: boolean;
  shadowOnly: boolean;
  score: number;
  confidence: number;         // 0..1
  grade: string;
  action: "execute" | "wait_for_pullback" | "shadow" | "reject";
  orderType: "market" | "limit" | "stop";
  limitPrice: number | null;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskReward: number | null;
  stopAtrMult: number | null;
  session: TradingSession;
  sessionScore: number;
  volatilityState: string;
  winProbability: number;
  expectedValueR: number;
  mtf: Record<Timeframe, Bias>;
  mtfConfirmed: boolean;
  components: Array<{ key: string; label: string; score: number; weight: number; detail: string }>;
  liquidity: { pools: Array<{ price: number; touches: number; side: string }>; sweep: boolean; structure: string };
  management: ReturnType<typeof managementPlan>;
  rejections: string[];
  notes: string[];
  reasoning: string;
  decisionId: string | null;
}

// ---------------------------------------------------------------------------
// Config + learned weights
// ---------------------------------------------------------------------------
export async function loadExecutionConfig(
  supabase: SupabaseClient, userId: string,
): Promise<ExecutionConfig> {
  const [{ data: s }, { data: model }] = await Promise.all([
    supabase.from("automation_settings").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("execution_model_params").select("*")
      .eq("user_id", userId).eq("active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const stored = (model?.params ?? null) as Partial<EntryWeights> | null;
  const weights = stored && Object.keys(stored).length
    ? normalizeWeights({ ...DEFAULT_WEIGHTS, ...stored })
    : DEFAULT_WEIGHTS;
  return {
    enabled: s?.exec_intel_enabled !== false,
    minConfidence: Math.max(0.5, Math.min(0.99, Number(s?.exec_min_confidence ?? 0.75))),
    sessionFilterEnabled: s?.exec_session_filter_enabled !== false,
    newsFilterEnabled: s?.news_filter_enabled !== false,
    maxSpreadBps: Number(s?.max_spread_bps ?? 30),
    minRR: Number(s?.min_risk_reward ?? 2),
    maxRR: Math.max(Number(s?.max_risk_reward ?? 4), 5),
    weights,
    modelVersion: Number(model?.version ?? s?.exec_model_version ?? 1),
  };
}

async function loadSessionStats(supabase: SupabaseClient, userId: string): Promise<SessionStat[]> {
  const { data } = await supabase.from("trade_memory")
    .select("session,profit,r_multiple")
    .eq("user_id", userId).not("outcome", "is", null).limit(1000);
  const buckets = new Map<string, { trades: number; wins: number; sum: number }>();
  for (const row of data ?? []) {
    const key = String(row.session ?? "off_hours");
    const b = buckets.get(key) ?? { trades: 0, wins: 0, sum: 0 };
    b.trades++;
    if (Number(row.profit ?? 0) > 0) b.wins++;
    b.sum += Number(row.r_multiple ?? 0);
    buckets.set(key, b);
  }
  return [...buckets.entries()].map(([session, b]) => ({
    session: session as TradingSession,
    trades: b.trades,
    winRate: b.trades ? b.wins / b.trades : 0,
    expectancy: b.trades ? b.sum / b.trades : 0,
  }));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
export async function evaluateExecution(
  supabase: SupabaseClient | null,
  userId: string | null,
  args: {
    symbol: string; side: Side; entry?: number;
    signalId?: string | null; strategyId?: string | null;
    spreadBps?: number | null;
    config?: ExecutionConfig;
    persist?: boolean;
  },
): Promise<ExecutionVerdict> {
  const cfg = args.config
    ?? (supabase && userId ? await loadExecutionConfig(supabase, userId) : {
      enabled: true, minConfidence: 0.75, sessionFilterEnabled: true, newsFilterEnabled: true,
      maxSpreadBps: 30, minRR: 2, maxRR: 5, weights: DEFAULT_WEIGHTS, modelVersion: 1,
    });

  const timeframes: Timeframe[] = [...MTF_ORDER];
  const series = await Promise.all(timeframes.map(tf =>
    fetchCandles(supabase, args.symbol, tf, tf === "5m" ? 260 : 220, userId).catch(() => [] as Candle[])));
  const byTf = new Map<Timeframe, Candle[]>();
  timeframes.forEach((tf, i) => byTf.set(tf, series[i]));

  const biases: Partial<Record<Timeframe, Bias>> = {};
  for (const tf of timeframes) {
    const c = byTf.get(tf) ?? [];
    biases[tf] = c.length ? biasFromCandles(c) : "neutral";
  }
  const mtf = multiTimeframeConfirmation(biases, args.side);

  const entryCandles = (byTf.get("5m")?.length ?? 0) >= 60
    ? byTf.get("5m")!
    : (byTf.get("15m")?.length ?? 0) >= 40 ? byTf.get("15m")! : (byTf.get("1h") ?? []);

  const rejections: string[] = [];
  const sessionStats = supabase && userId ? await loadSessionStats(supabase, userId) : [];
  const timing = evaluateEntryTiming({
    candles: entryCandles, side: args.side, mtf,
    spreadBps: args.spreadBps ?? null, maxSpreadBps: cfg.maxSpreadBps,
    sessionStats,
  }, cfg.weights);

  const session = classifySession();
  if (!timing) {
    return finalize({
      symbol: args.symbol, side: args.side, score: 0, grade: "F",
      rejections: ["Not enough market data on the entry timeframe"],
      session, sessionScore: 0, cfg, entry: args.entry ?? 0,
      mtf, notes: [], timing: null, adxValue: null, decisionId: null,
    });
  }

  // Hard gates ---------------------------------------------------------------
  if (!mtf.confirmed) {
    // Report the HTF subset that actually decides the gate (1D/4H/1H), not the
    // 5-timeframe tally — the old wording made a passing "1 opposed" case look
    // like a contradiction of the ≤1-opposing rule.
    const htfDetail = (["1d", "4h", "1h"] as const)
      .map(tf => `${tf.toUpperCase()} ${mtf.biases[tf]}`).join(", ");
    rejections.push(
      `Higher-timeframe confirmation failed (${htfDetail}; needs 2 of 3 agreeing and at most 1 opposing)`,
    );
  }
  if (timing.volatility && !timing.volatility.tradable) {
    rejections.push(timing.volatility.spreadOk
      ? `Volatility state "${timing.volatility.state}" is untradeable`
      : `Spread ${timing.volatility.spreadBps?.toFixed(1)} bps exceeds the ${cfg.maxSpreadBps} bps budget`);
  }
  if (cfg.newsFilterEnabled) {
    const ev = checkEventWindow();
    if (ev.active) rejections.push(`News/event window: ${ev.reason}`);
  }
  if (cfg.sessionFilterEnabled && timing.sessionScore < 25) {
    rejections.push(`Session "${session.replace(/_/g, " ")}" scores ${timing.sessionScore} — outside tradeable hours`);
  }
  if (timing.structure === (args.side === "buy" ? "bos_down" : "bos_up")
    || timing.structure === (args.side === "buy" ? "choch_down" : "choch_up")) {
    rejections.push("Market structure broke against the trade direction");
  }

  const a = adx(entryCandles, 14);
  const frame = dynamicFrame({
    candles: entryCandles, side: args.side, entry: args.entry,
    volatility: timing.volatility?.state ?? "normal",
    adxValue: a?.adx ?? null, entryScore: timing.score,
    minRR: cfg.minRR, maxRR: cfg.maxRR,
  });
  if (!frame) rejections.push("Could not derive an ATR/structure risk frame");
  if (frame && frame.riskReward < cfg.minRR) {
    rejections.push(`Reward 1:${frame.riskReward} below the 1:${cfg.minRR} floor`);
  }

  const confidence = Math.max(0, Math.min(0.99, timing.score / 100));
  if (confidence < cfg.minConfidence) {
    rejections.push(`Entry confidence ${(confidence * 100).toFixed(1)}% below the ${(cfg.minConfidence * 100).toFixed(0)}% floor`);
  }

  const verdict = finalize({
    symbol: args.symbol, side: args.side, score: timing.score, grade: timing.grade,
    rejections, session, sessionScore: timing.sessionScore, cfg,
    entry: frame?.entry ?? args.entry ?? timing.price,
    mtf, notes: timing.notes, timing, adxValue: a?.adx ?? null, frame, decisionId: null,
  });

  if (supabase && userId && args.persist !== false) {
    const { data } = await supabase.from("execution_decisions").insert({
      user_id: userId,
      signal_id: args.signalId ?? null,
      strategy_id: args.strategyId ?? null,
      symbol: args.symbol, side: args.side,
      entry_score: verdict.score, action: verdict.action,
      order_type: verdict.orderType, limit_price: verdict.limitPrice,
      stop_loss: verdict.stopLoss, take_profit: verdict.takeProfit,
      risk_reward: verdict.riskReward, grade: verdict.grade,
      confidence: verdict.confidence, session: verdict.session,
      session_score: verdict.sessionScore, volatility_state: verdict.volatilityState,
      expected_value: verdict.expectedValueR, win_probability: verdict.winProbability,
      approved: verdict.approved, shadow_only: verdict.shadowOnly,
      mtf: verdict.mtf as never,
      components: Object.fromEntries(verdict.components.map(c => [c.key, c.score])) as never,
      liquidity: verdict.liquidity as never,
      rejections: verdict.rejections as never,
    }).select("id").maybeSingle();
    verdict.decisionId = data?.id ?? null;
  }
  return verdict;
}

function finalize(input: {
  symbol: string; side: Side; score: number; grade: string; rejections: string[];
  session: TradingSession; sessionScore: number; cfg: ExecutionConfig; entry: number;
  mtf: ReturnType<typeof multiTimeframeConfirmation>; notes: string[];
  timing: ReturnType<typeof evaluateEntryTiming>; adxValue: number | null;
  frame?: ReturnType<typeof dynamicFrame>; decisionId: string | null;
}): ExecutionVerdict {
  const { timing, frame, cfg } = input;
  const volState = timing?.volatility?.state ?? "normal";
  const confidence = Math.max(0, Math.min(0.99, input.score / 100));
  const p = winProbability(input.score, input.mtf.confirmed);
  const rr = frame?.riskReward ?? null;
  const ev = rr ? expectedValueR(p, rr) : 0;

  const order = timing && frame
    ? chooseOrderType({
      side: input.side, price: frame.entry, atr: timing.atr, retrace: timing.retrace,
      structure: timing.structure, volatility: volState, vwap: timing.vwap,
    })
    : { type: "market" as const, price: null, reason: "" };

  const structuralFailure = input.rejections.some(r =>
    r.includes("structure broke") || r.includes("untradeable") || r.includes("News/event")
    || r.includes("Session") || r.includes("Higher-timeframe") || r.includes("market data"));
  const onlyConfidence = input.rejections.length > 0 && !structuralFailure;

  const approved = input.rejections.length === 0;
  const action: ExecutionVerdict["action"] = approved
    ? (order.type === "market" ? "execute" : "wait_for_pullback")
    : onlyConfidence ? "shadow" : "reject";

  const reasoning = approved
    ? `${input.side.toUpperCase()} ${input.symbol} — grade ${input.grade} entry (${input.score.toFixed(1)}/100). `
    + `${input.mtf.aligned}/5 timeframes aligned, ${volState} volatility, ${input.session.replace(/_/g, " ")} session. `
    + `${order.reason}. Stop ${frame?.stopLoss} (${frame?.stopAtrMult}× ATR, ${frame?.basis}), target ${frame?.takeProfit} at 1:${rr}. `
    + `Modelled win rate ${(p * 100).toFixed(0)}% → expectancy ${ev}R.`
    : `${input.side.toUpperCase()} ${input.symbol} held back — ${input.rejections[0]}.`;

  return {
    symbol: input.symbol, side: input.side, approved,
    shadowOnly: action === "shadow",
    score: input.score, confidence, grade: input.grade, action,
    orderType: order.type, limitPrice: order.price,
    entry: input.entry,
    stopLoss: frame?.stopLoss ?? null,
    takeProfit: frame?.takeProfit ?? null,
    riskReward: rr,
    stopAtrMult: frame?.stopAtrMult ?? null,
    session: input.session, sessionScore: input.sessionScore,
    volatilityState: volState,
    winProbability: p, expectedValueR: ev,
    mtf: input.mtf.biases, mtfConfirmed: input.mtf.confirmed,
    components: timing?.components.map(c => ({
      key: c.key, label: c.label, score: c.score, weight: c.weight, detail: c.detail,
    })) ?? [],
    liquidity: {
      pools: timing?.pools ?? [],
      sweep: timing?.sweep ?? false,
      structure: timing?.structure ?? "none",
    },
    management: managementPlan(volState),
    rejections: input.rejections,
    notes: [...input.notes, ...(cfg.enabled ? [] : ["Execution Intelligence is disabled — running in observe-only mode"])],
    reasoning,
    decisionId: input.decisionId,
  };
}

// ---------------------------------------------------------------------------
// Trade memory — what the market looked like at entry, and how it resolved
// ---------------------------------------------------------------------------
export async function syncTradeMemory(
  supabase: SupabaseClient, userId: string,
): Promise<{ inserted: number }> {
  const [{ data: closed }, { data: memory }] = await Promise.all([
    supabase.from("positions")
      .select("id,symbol,side,avg_entry,stop_loss,exit_price,realized_pnl,ai_regime,opened_at,closed_at,duration_seconds,entry_score,trade_grade")
      .eq("user_id", userId).eq("status", "closed")
      .order("closed_at", { ascending: false }).limit(300),
    supabase.from("trade_memory").select("position_id").eq("user_id", userId).limit(1000),
  ]);
  const seen = new Set((memory ?? []).map(m => m.position_id));
  const pending = (closed ?? []).filter(p => !seen.has(p.id));
  if (!pending.length) return { inserted: 0 };

  const { data: decisions } = await supabase.from("execution_decisions")
    .select("id,symbol,side,entry_score,grade,session,components,created_at,volatility_state")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(500);

  const rows = pending.map(p => {
    const openedAt = p.opened_at ? new Date(p.opened_at).getTime() : 0;
    const match = (decisions ?? []).find(d =>
      d.symbol === p.symbol
      && Math.abs(new Date(d.created_at).getTime() - openedAt) < 45 * 60 * 1000);
    const entry = Number(p.avg_entry ?? 0);
    const stop = Number(p.stop_loss ?? 0);
    const risk = Math.abs(entry - stop) || entry * 0.01;
    const exit = Number(p.exit_price ?? entry);
    const dir = p.side === "long" ? 1 : -1;
    const rMultiple = risk > 0 ? ((exit - entry) * dir) / risk : 0;
    const profit = Number(p.realized_pnl ?? 0);
    return {
      user_id: userId, position_id: p.id, decision_id: match?.id ?? null,
      symbol: p.symbol, side: p.side === "long" ? "buy" : "sell",
      entry_score: match?.entry_score ?? p.entry_score ?? null,
      grade: match?.grade ?? p.trade_grade ?? null,
      session: match?.session ?? classifySession(p.opened_at ? new Date(p.opened_at) : undefined),
      regime: p.ai_regime ?? null,
      entry_timing: classifyEntryTiming({
        maxAdverseExcursionR: rMultiple < 0 ? Math.abs(rMultiple) : 0,
        maxFavorableExcursionR: Math.max(0, rMultiple),
        rMultiple,
      }),
      indicators: (match?.components ?? {}) as never,
      market_condition: { volatility: match?.volatility_state ?? null } as never,
      outcome: profit > 0 ? "win" : profit < 0 ? "loss" : "flat",
      profit, r_multiple: +rMultiple.toFixed(4),
      max_favorable_excursion: Math.max(0, +rMultiple.toFixed(4)),
      max_adverse_excursion: rMultiple < 0 ? +Math.abs(rMultiple).toFixed(4) : 0,
      hold_seconds: p.duration_seconds ?? null,
      closed_at: p.closed_at,
    };
  });

  await supabase.from("trade_memory").upsert(rows, { onConflict: "position_id" });
  return { inserted: rows.length };
}

// ---------------------------------------------------------------------------
// Self-learning — re-optimise every 50 closed trades, promote only at 95%
// ---------------------------------------------------------------------------
export async function runExecutionLearning(
  supabase: SupabaseClient, userId: string, opts: { force?: boolean } = {},
): Promise<{
  ran: boolean; reason?: string; version?: number; promoted?: boolean;
  confidence?: number; deltas?: Record<string, number>; evaluated?: number;
}> {
  await syncTradeMemory(supabase, userId);

  const [{ count }, { data: lastModel }] = await Promise.all([
    supabase.from("trade_memory").select("id", { count: "exact", head: true }).eq("user_id", userId),
    supabase.from("execution_model_params").select("*")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const total = count ?? 0;
  const since = total - Number(lastModel?.trades_evaluated ?? 0);
  if (!opts.force && since < LEARNING_INTERVAL) {
    return { ran: false, reason: `${LEARNING_INTERVAL - since} more closed trades until the next re-optimisation` };
  }

  const { data: rows } = await supabase.from("trade_memory")
    .select("indicators,r_multiple,entry_timing,entry_score")
    .eq("user_id", userId).order("closed_at", { ascending: false }).limit(400);
  const samples: MemorySample[] = (rows ?? [])
    .filter(r => r.indicators && Object.keys(r.indicators as object).length)
    .map(r => ({
      components: r.indicators as Record<string, number>,
      rMultiple: Number(r.r_multiple ?? 0),
    }));

  const current = lastModel?.params && Object.keys(lastModel.params as object).length
    ? normalizeWeights({ ...DEFAULT_WEIGHTS, ...(lastModel.params as Partial<EntryWeights>) })
    : DEFAULT_WEIGHTS;
  const { weights, changed, deltas } = reoptimizeWeights(current, samples, opts.force ? 20 : LEARNING_INTERVAL);

  // Backtest the candidate against the incumbent on the same trade memory:
  // rescore every remembered entry with both weight sets and compare the
  // R-multiples of the trades each model would have accepted.
  const scoreWith = (w: EntryWeights, c: Record<string, number>) =>
    (Object.keys(w) as (keyof EntryWeights)[])
      .reduce((s, k) => s + (Number(c[k] ?? 50) * w[k]), 0);
  const threshold = 72; // grade B and above
  const baseline = samples.filter(s => scoreWith(current, s.components) >= threshold).map(s => s.rMultiple);
  const candidate = samples.filter(s => scoreWith(weights, s.components) >= threshold).map(s => s.rMultiple);
  const test = welchTTest(candidate, baseline);
  const promoted = changed && test.significant;

  const version = Number(lastModel?.version ?? 0) + 1;
  const timings = (rows ?? []).map(r => String(r.entry_timing ?? ""));
  await supabase.from("execution_model_params").insert({
    user_id: userId, version, params: (promoted ? weights : current) as never,
    trades_evaluated: total,
    late_entries: timings.filter(t => t === "late").length,
    early_entries: timings.filter(t => t === "early").length,
    perfect_entries: timings.filter(t => t === "perfect").length,
    active: promoted,
    notes: promoted
      ? `Promoted at ${test.confidence}% confidence (t=${test.t}, n=${candidate.length} vs ${baseline.length})`
      : `Held incumbent — candidate reached only ${test.confidence}% confidence`,
  });
  if (promoted) {
    await supabase.from("execution_model_params").update({ active: false })
      .eq("user_id", userId).neq("version", version);
    await supabase.from("execution_model_params").update({ active: true })
      .eq("user_id", userId).eq("version", version);
    await supabase.from("automation_settings").update({ exec_model_version: version })
      .eq("user_id", userId);
  }
  await supabase.from("execution_backtests").insert({
    user_id: userId,
    baseline: { weights: current, trades: baseline.length, avgR: avg(baseline) } as never,
    candidate: { weights, trades: candidate.length, avgR: avg(candidate) } as never,
    p_value: test.pValue, confidence: test.confidence, promoted,
    summary: promoted
      ? `New execution model v${version} beats the incumbent with ${test.confidence}% statistical confidence.`
      : `Candidate model kept in shadow — ${test.confidence}% confidence is below the 95% promotion bar.`,
  });

  return { ran: true, version, promoted, confidence: test.confidence, deltas, evaluated: total };
}

function avg(x: number[]) { return x.length ? +(x.reduce((s, v) => s + v, 0) / x.length).toFixed(4) : 0; }

// ---------------------------------------------------------------------------
// Dashboard aggregation
// ---------------------------------------------------------------------------
export async function loadExecutionIntel(supabase: SupabaseClient, userId: string) {
  await syncTradeMemory(supabase, userId).catch(() => ({ inserted: 0 }));
  const cfg = await loadExecutionConfig(supabase, userId);
  const [decisions, memory, models, backtests] = await Promise.all([
    supabase.from("execution_decisions").select("*")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(60),
    supabase.from("trade_memory").select("*")
      .eq("user_id", userId).order("closed_at", { ascending: false }).limit(300),
    supabase.from("execution_model_params").select("*")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(8),
    supabase.from("execution_backtests").select("*")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(5),
  ]);

  const mem = memory.data ?? [];
  const byGrade = new Map<string, { trades: number; wins: number; sumR: number }>();
  const bySession = new Map<string, { trades: number; wins: number; sumR: number }>();
  for (const m of mem) {
    const g = String(m.grade ?? gradeFor(Number(m.entry_score ?? 0)));
    const gb = byGrade.get(g) ?? { trades: 0, wins: 0, sumR: 0 };
    gb.trades++; if (Number(m.profit ?? 0) > 0) gb.wins++; gb.sumR += Number(m.r_multiple ?? 0);
    byGrade.set(g, gb);
    const s = String(m.session ?? "off_hours");
    const sb = bySession.get(s) ?? { trades: 0, wins: 0, sumR: 0 };
    sb.trades++; if (Number(m.profit ?? 0) > 0) sb.wins++; sb.sumR += Number(m.r_multiple ?? 0);
    bySession.set(s, sb);
  }
  const shape = (map: Map<string, { trades: number; wins: number; sumR: number }>) =>
    [...map.entries()].map(([key, v]) => ({
      key, trades: v.trades,
      winRate: +((v.wins / v.trades) * 100).toFixed(1),
      avgR: +(v.sumR / v.trades).toFixed(3),
    })).sort((a, b) => b.trades - a.trades);

  const decs = decisions.data ?? [];
  const timings = mem.map(m => String(m.entry_timing ?? ""));
  const active = (models.data ?? []).find(m => m.active) ?? models.data?.[0] ?? null;

  return {
    config: cfg,
    decisions: decs,
    approvals: decs.filter(d => d.approved).length,
    shadowed: decs.filter(d => d.shadow_only).length,
    rejected: decs.filter(d => !d.approved && !d.shadow_only).length,
    avgScore: decs.length ? +(decs.reduce((s, d) => s + Number(d.entry_score ?? 0), 0) / decs.length).toFixed(1) : 0,
    byGrade: shape(byGrade),
    bySession: shape(bySession),
    timing: {
      perfect: timings.filter(t => t === "perfect").length,
      late: timings.filter(t => t === "late").length,
      early: timings.filter(t => t === "early").length,
      invalid: timings.filter(t => t === "invalid").length,
    },
    tradesUntilLearning: Math.max(0, LEARNING_INTERVAL - (mem.length - Number(active?.trades_evaluated ?? 0))),
    learningInterval: LEARNING_INTERVAL,
    models: models.data ?? [],
    activeModel: active,
    backtests: backtests.data ?? [],
    recentMemory: mem.slice(0, 40),
  };
}
