// AI Performance Validation & Live Optimization Engine
// -----------------------------------------------------------------------------
// Continuous evaluation of strategies, models, and autonomous decisions.
// Rule: never optimize for raw profit — favor risk-adjusted, robust performance.
// All production-changing recommendations require explicit user approval.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const num = (v: unknown, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stddev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
function sharpe(returns: number[]) {
  const s = stddev(returns);
  return s === 0 ? 0 : (mean(returns) / s) * Math.sqrt(252);
}
function maxDrawdown(cum: number[]) {
  let peak = -Infinity, dd = 0;
  for (const v of cum) { peak = Math.max(peak, v); dd = Math.min(dd, v - peak); }
  return dd; // negative
}
function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

// =============================================================================
// 1. Live Performance Attribution — which part of the system makes money?
// =============================================================================
export const getPerformanceAttribution = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("trade_journal")
      .select("symbol,strategy_id,market_regime,realized_pnl,fees_total,slippage_bps_avg,execution_quality_score,ai_confidence,attribution,exit_reason")
      .eq("user_id", context.userId)
      .limit(2000);
    const rows = (data ?? []) as Row[];

    const groupSum = (key: string) => {
      const m = new Map<string, { pnl: number; n: number; wins: number }>();
      for (const r of rows) {
        const k = String(r[key] ?? "unknown");
        const b = m.get(k) ?? { pnl: 0, n: 0, wins: 0 };
        const p = num(r.realized_pnl);
        b.pnl += p; b.n += 1; if (p > 0) b.wins += 1;
        m.set(k, b);
      }
      return Array.from(m.entries())
        .map(([k, v]) => ({ key: k, pnl: v.pnl, trades: v.n, win_rate: v.n ? v.wins / v.n : 0 }))
        .sort((a, b) => b.pnl - a.pnl);
    };

    // Signal source contribution comes from attribution jsonb
    const signalMap = new Map<string, { pnl: number; n: number }>();
    for (const r of rows) {
      const attr = (r.attribution as Row) ?? {};
      const src = String(attr.signal_source ?? attr.source ?? "ai_engine");
      const b = signalMap.get(src) ?? { pnl: 0, n: 0 };
      b.pnl += num(r.realized_pnl); b.n += 1;
      signalMap.set(src, b);
    }
    const bySignalSource = Array.from(signalMap.entries())
      .map(([k, v]) => ({ key: k, pnl: v.pnl, trades: v.n }))
      .sort((a, b) => b.pnl - a.pnl);

    const totalPnl = rows.reduce((s, r) => s + num(r.realized_pnl), 0);
    const totalFees = rows.reduce((s, r) => s + num(r.fees_total), 0);
    const avgSlippage = mean(rows.map(r => num(r.slippage_bps_avg)));
    const avgExecQuality = mean(rows.map(r => num(r.execution_quality_score)));

    // Risk contribution — pnl by confidence bucket (risk-adjusted view)
    const riskBuckets = new Map<string, { pnl: number; n: number }>();
    for (const r of rows) {
      const c = num(r.ai_confidence);
      const k = c >= 0.8 ? "high_conf" : c >= 0.6 ? "med_conf" : "low_conf";
      const b = riskBuckets.get(k) ?? { pnl: 0, n: 0 };
      b.pnl += num(r.realized_pnl); b.n += 1;
      riskBuckets.set(k, b);
    }

    return {
      totals: { pnl: totalPnl, fees: totalFees, trades: rows.length, avg_slippage_bps: avgSlippage, avg_exec_quality: avgExecQuality },
      byStrategy: groupSum("strategy_id"),
      byAsset: groupSum("symbol"),
      byRegime: groupSum("market_regime"),
      bySignalSource,
      byRiskBucket: Array.from(riskBuckets.entries()).map(([k, v]) => ({ key: k, pnl: v.pnl, trades: v.n })),
      executionContribution: { avg_slippage_bps: avgSlippage, avg_exec_quality: avgExecQuality, total_fee_drag: -totalFees },
    };
  });

// =============================================================================
// 2. AI Prediction Calibration
// =============================================================================
export const getCalibration = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("trade_journal")
      .select("symbol,strategy_id,market_regime,ai_confidence,realized_pnl,duration_seconds,created_at")
      .eq("user_id", context.userId)
      .limit(2000);
    const rows = (data ?? []) as Row[];

    // Calibration curve buckets
    const bins = [0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
    const curve = bins.slice(0, -1).map((lo, i) => {
      const hi = bins[i + 1];
      const inBin = rows.filter(r => {
        const c = num(r.ai_confidence);
        return c >= lo && c < hi;
      });
      const wins = inBin.filter(r => num(r.realized_pnl) > 0).length;
      const predicted = (lo + hi) / 2;
      const actual = inBin.length ? wins / inBin.length : 0;
      return { bucket: `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`, predicted, actual, n: inBin.length };
    });

    // Reliability score: 1 - mean absolute calibration error weighted by sample
    const totalN = curve.reduce((s, c) => s + c.n, 0);
    const calError = totalN
      ? curve.reduce((s, c) => s + c.n * Math.abs(c.predicted - c.actual), 0) / totalN
      : 0;
    const reliability = clamp01(1 - 2 * calError);

    const byDim = (key: string) => {
      const m = new Map<string, { n: number; wins: number; conf: number }>();
      for (const r of rows) {
        const k = String(r[key] ?? "unknown");
        const b = m.get(k) ?? { n: 0, wins: 0, conf: 0 };
        b.n += 1; b.conf += num(r.ai_confidence);
        if (num(r.realized_pnl) > 0) b.wins += 1;
        m.set(k, b);
      }
      return Array.from(m.entries()).map(([k, v]) => ({
        key: k, n: v.n, accuracy: v.n ? v.wins / v.n : 0, avg_conf: v.n ? v.conf / v.n : 0,
      }));
    };

    // False confidence: high confidence but low realized accuracy
    const falseConfidence = curve
      .filter(c => c.n >= 5 && c.predicted >= 0.75 && c.actual < c.predicted - 0.2)
      .map(c => ({ bucket: c.bucket, gap: c.predicted - c.actual, sample: c.n }));

    return {
      curve,
      calibrationError: calError,
      reliabilityScore: reliability,
      byAsset: byDim("symbol"),
      byRegime: byDim("market_regime"),
      byStrategy: byDim("strategy_id"),
      falseConfidence,
      sampleSize: rows.length,
    };
  });

// =============================================================================
// 3. Live vs Backtest vs Shadow comparison
// =============================================================================
export const getEnvironmentComparison = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [journalR, shadowR, backtestR] = await Promise.all([
      context.supabase.from("trade_journal").select("realized_pnl,slippage_bps_avg,ai_confidence").eq("user_id", context.userId).limit(1000),
      context.supabase.from("shadow_trades").select("pnl,confidence,status").eq("user_id", context.userId).limit(1000),
      context.supabase.from("backtest_runs").select("metrics,created_at").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(20),
    ]);

    const journal = (journalR.data ?? []) as Row[];
    const shadow = (shadowR.data ?? []) as Row[];
    const backtests = ((backtestR.data ?? []) as Row[])
      .map(r => (r.metrics ?? {}) as Row);

    const liveWins = journal.filter(r => num(r.realized_pnl) > 0).length;
    const closedShadow = shadow.filter(r => r.status === "closed");
    const shadowWins = closedShadow.filter(r => num(r.pnl) > 0).length;

    const live = {
      trades: journal.length,
      pnl: journal.reduce((s, r) => s + num(r.realized_pnl), 0),
      win_rate: journal.length ? liveWins / journal.length : 0,
      avg_slippage_bps: mean(journal.map(r => num(r.slippage_bps_avg))),
    };
    const shadowM = {
      trades: closedShadow.length,
      pnl: closedShadow.reduce((s, r) => s + num(r.pnl), 0),
      win_rate: closedShadow.length ? shadowWins / closedShadow.length : 0,
      avg_confidence: mean(closedShadow.map(r => num(r.confidence))),
    };
    const backtestAvg = {
      runs: backtests.length,
      avg_return_pct: mean(backtests.map(r => num(r.total_return_pct ?? r.return_pct))),
      avg_sharpe: mean(backtests.map(r => num(r.sharpe_ratio ?? r.sharpe))),
      avg_max_dd_pct: mean(backtests.map(r => num(r.max_drawdown_pct ?? r.max_dd))),
      avg_win_rate: mean(backtests.map(r => num(r.win_rate))),
    };

    const overfitGap = backtestAvg.avg_win_rate - live.win_rate;
    const degradation = shadowM.pnl > 0 && live.pnl < 0 ? "live_underperforms_shadow" : "none";

    return {
      live, shadow: shadowM, backtest: backtestAvg,
      diagnostics: {
        overfitting_suspected: overfitGap > 0.2 && backtests.length >= 3 && journal.length >= 20,
        overfit_gap: overfitGap,
        degradation,
      },
    };
  });

// =============================================================================
// 4. Alpha Decay Detection
// =============================================================================
export const getAlphaDecay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("trade_journal")
      .select("strategy_id,realized_pnl,created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: true })
      .limit(3000);
    const rows = (data ?? []) as Row[];

    const byStrat = new Map<string, { pnl: number; ts: number }[]>();
    for (const r of rows) {
      const s = String(r.strategy_id ?? "unknown");
      const arr = byStrat.get(s) ?? [];
      arr.push({ pnl: num(r.realized_pnl), ts: new Date(String(r.created_at)).getTime() });
      byStrat.set(s, arr);
    }

    const report: Array<Row> = [];
    for (const [strat, arr] of byStrat) {
      if (arr.length < 10) continue;
      const half = Math.floor(arr.length / 2);
      const early = arr.slice(0, half).map(x => x.pnl);
      const recent = arr.slice(half).map(x => x.pnl);
      const earlyMean = mean(early);
      const recentMean = mean(recent);
      const decayPct = earlyMean === 0 ? 0 : ((recentMean - earlyMean) / Math.abs(earlyMean)) * 100;
      const decaying = recentMean < earlyMean * 0.7 && earlyMean > 0;
      report.push({
        strategy_id: strat, sample: arr.length,
        early_avg_pnl: earlyMean, recent_avg_pnl: recentMean,
        decay_pct: decayPct, decaying,
        recommendation: decaying ? "review_or_reduce_weight" : "monitor",
      });
    }
    return { report };
  });

// =============================================================================
// 5. Strategy Health Scoring
// =============================================================================
async function computeHealthForStrategy(supabase: any, userId: string, strategyId: string) {
  const { data } = await supabase
    .from("trade_journal")
    .select("realized_pnl,execution_quality_score,slippage_bps_avg,market_regime,created_at")
    .eq("user_id", userId)
    .eq("strategy_id", strategyId)
    .order("created_at", { ascending: true })
    .limit(500);
  const rows = (data ?? []) as Row[];
  if (rows.length < 5) return null;

  const pnls = rows.map(r => num(r.realized_pnl));
  const cum: number[] = [];
  pnls.reduce((a, b, i) => { cum[i] = a + b; return cum[i]; }, 0);

  const wins = pnls.filter(p => p > 0).length;
  const profitability = clamp01(wins / pnls.length);
  const stability = clamp01(1 - stddev(pnls) / (Math.abs(mean(pnls)) + Math.abs(mean(pnls.map(Math.abs))) + 1));
  const dd = maxDrawdown(cum);
  const drawdownScore = clamp01(1 - Math.abs(dd) / (Math.max(...cum, 1) + 1));
  const sh = sharpe(pnls);
  const sharpeScore = clamp01((sh + 1) / 4); // -1..3 -> 0..1
  const recent = pnls.slice(-Math.min(20, pnls.length));
  const recentPerf = clamp01((mean(recent) - mean(pnls)) / (Math.abs(mean(pnls)) + 1) + 0.5);
  const regimeSet = new Set(rows.map(r => String(r.market_regime ?? "")));
  const regimeFit = clamp01(regimeSet.size / 4);
  const execQuality = clamp01(mean(rows.map(r => num(r.execution_quality_score))) / 100);

  const score = 100 * (
    0.20 * profitability +
    0.15 * stability +
    0.15 * drawdownScore +
    0.20 * sharpeScore +
    0.15 * recentPerf +
    0.05 * regimeFit +
    0.10 * execQuality
  );

  let classification: "healthy" | "warning" | "degrading" | "retire";
  if (score >= 70) classification = "healthy";
  else if (score >= 55) classification = "warning";
  else if (score >= 40) classification = "degrading";
  else classification = "retire";

  return {
    strategy_id: strategyId, score, classification,
    profitability, stability, drawdown: drawdownScore, sharpe: sharpeScore,
    recent_perf: recentPerf, regime_fit: regimeFit, execution_quality: execQuality,
    sample_size: rows.length,
    details: { avg_pnl: mean(pnls), sharpe_raw: sh, max_dd: dd },
  };
}

export const refreshStrategyHealthScores = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("trade_journal")
      .select("strategy_id")
      .eq("user_id", context.userId)
      .not("strategy_id", "is", null);
    const strategies = Array.from(new Set(((data ?? []) as Row[]).map(r => String(r.strategy_id))));

    const results = [];
    for (const s of strategies) {
      const h = await computeHealthForStrategy(context.supabase, context.userId, s);
      if (!h) continue;
      await context.supabase.from("strategy_health_scores").insert({ user_id: context.userId, ...h });
      results.push(h);
    }
    return { computed: results.length, strategies: results };
  });

export const getStrategyHealthScores = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("strategy_health_scores")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(200);
    // latest per strategy
    const latest = new Map<string, Row>();
    for (const r of (data ?? []) as Row[]) {
      const k = String(r.strategy_id);
      if (!latest.has(k)) latest.set(k, r);
    }
    return { latest: Array.from(latest.values()), history: data ?? [] };
  });

// =============================================================================
// 6. AI Self-Review Journal (uses Lovable AI Gateway)
// =============================================================================
export const reviewTrade = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ journalId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: trade } = await context.supabase
      .from("trade_journal")
      .select("*")
      .eq("user_id", context.userId)
      .eq("id", data.journalId)
      .maybeSingle();
    if (!trade) throw new Error("Trade not found");

    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const prompt = `Analyze this trade and produce a JSON review. Trade:\n${JSON.stringify(trade, null, 2)}\n\nReturn strict JSON with keys: success_factors, failure_factors, confidence_accuracy, risk_appropriateness, market_condition_change, lessons. Each value is a short string (max 200 chars). Focus on risk-adjusted quality, not just profit.`;

    const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "You are a disciplined trading auditor. Return only valid JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!resp.ok) throw new Error(`AI gateway ${resp.status}`);
    const body = await resp.json();
    const content = body.choices?.[0]?.message?.content ?? "{}";
    let parsed: Record<string, string> = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }

    const pnl = num(trade.realized_pnl);
    const outcome = pnl > 0 ? "win" : pnl < 0 ? "loss" : "flat";

    const { data: inserted } = await context.supabase
      .from("trade_reviews")
      .insert({
        user_id: context.userId,
        journal_id: data.journalId,
        symbol: trade.symbol,
        strategy_id: trade.strategy_id,
        regime: trade.market_regime,
        confidence: trade.ai_confidence,
        realized_pnl: pnl,
        outcome,
        success_factors: parsed.success_factors ?? null,
        failure_factors: parsed.failure_factors ?? null,
        confidence_accuracy: parsed.confidence_accuracy ?? null,
        risk_appropriateness: parsed.risk_appropriateness ?? null,
        market_condition_change: parsed.market_condition_change ?? null,
        lessons: parsed.lessons ?? null,
        ai_model: "google/gemini-2.5-flash",
      })
      .select()
      .single();

    return inserted;
  });

export const getTradeReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("trade_reviews")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(100);
    return { reviews: data ?? [] };
  });

// =============================================================================
// 7. Optimization Recommendation Engine
// =============================================================================
export const generateRecommendations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const [journalR, healthR, driftR] = await Promise.all([
      supabase.from("trade_journal").select("strategy_id,market_regime,ai_confidence,realized_pnl,created_at").eq("user_id", userId).limit(2000),
      supabase.from("strategy_health_scores").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      supabase.from("model_drift_snapshots").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
    ]);
    const journal = (journalR.data ?? []) as Row[];
    const health = (healthR.data ?? []) as Row[];
    const drift = (driftR.data ?? []) as Row[];

    const recs: Array<Row> = [];

    // Rule 1: unhealthy strategy -> reduce allocation
    const latestHealth = new Map<string, Row>();
    for (const h of health) {
      const k = String(h.strategy_id);
      if (!latestHealth.has(k)) latestHealth.set(k, h);
    }
    for (const h of latestHealth.values()) {
      if (h.classification === "degrading" || h.classification === "retire") {
        recs.push({
          kind: "strategy_allocation",
          target: h.strategy_id,
          title: `Reduce allocation for ${h.strategy_id}`,
          rationale: `Health score ${num(h.score).toFixed(1)} (${h.classification}). Risk-adjusted metrics degraded.`,
          suggested_change: { action: "reduce_weight", factor: h.classification === "retire" ? 0.0 : 0.5 },
          evidence: { score: h.score, classification: h.classification, sample: h.sample_size },
          severity: h.classification === "retire" ? "high" : "medium",
        });
      }
    }

    // Rule 2: regime-specific outperformance
    const regStat = new Map<string, Map<string, { pnl: number; n: number }>>();
    for (const r of journal) {
      const s = String(r.strategy_id ?? "unknown");
      const reg = String(r.market_regime ?? "unknown");
      if (!regStat.has(s)) regStat.set(s, new Map());
      const m = regStat.get(s)!;
      const b = m.get(reg) ?? { pnl: 0, n: 0 };
      b.pnl += num(r.realized_pnl); b.n += 1;
      m.set(reg, b);
    }
    for (const [strat, m] of regStat) {
      const best = Array.from(m.entries()).filter(([, v]) => v.n >= 5).sort((a, b) => b[1].pnl / b[1].n - a[1].pnl / a[1].n)[0];
      if (best && best[1].pnl > 0) {
        recs.push({
          kind: "regime_filter",
          target: strat,
          title: `${strat} performs best in ${best[0]} regime`,
          rationale: `Avg PnL per trade highest in ${best[0]} regime (sample ${best[1].n}). Consider restricting execution to this regime.`,
          suggested_change: { action: "add_regime_filter", regime: best[0] },
          evidence: { by_regime: Object.fromEntries(m) },
          severity: "info",
        });
      }
    }

    // Rule 3: high-volatility -> raise confidence threshold
    const highConfWinRate = (() => {
      const hc = journal.filter(r => num(r.ai_confidence) >= 0.75);
      return hc.length ? hc.filter(r => num(r.realized_pnl) > 0).length / hc.length : 0;
    })();
    if (journal.length >= 30 && highConfWinRate < 0.5) {
      recs.push({
        kind: "confidence_threshold",
        target: "global",
        title: "Raise confidence threshold",
        rationale: `High-confidence trades (>=75%) win rate is only ${(highConfWinRate * 100).toFixed(1)}%. Model over-signals.`,
        suggested_change: { action: "raise_min_confidence", new_min: 0.8 },
        evidence: { high_conf_win_rate: highConfWinRate, sample: journal.length },
        severity: "medium",
      });
    }

    // Rule 4: drift detected
    for (const d of drift) {
      if (d.drift_flag) {
        recs.push({
          kind: "model_retrain",
          target: String(d.model),
          title: `Model ${d.model} shows drift — review`,
          rationale: String(d.drift_reason ?? "Distribution or accuracy shift detected."),
          suggested_change: { action: "flag_for_retrain" },
          evidence: { drift: d },
          severity: "high",
        });
      }
    }

    // Insert unique recs (dedupe by title within pending)
    const { data: existing } = await supabase
      .from("optimization_recommendations")
      .select("title,status")
      .eq("user_id", userId)
      .eq("status", "pending");
    const existingTitles = new Set(((existing ?? []) as Row[]).map(e => String(e.title)));

    const toInsert = recs.filter(r => !existingTitles.has(String(r.title)));
    if (toInsert.length) {
      await supabase.from("optimization_recommendations").insert(
        toInsert.map(r => ({
          user_id: userId,
          kind: String(r.kind),
          target: r.target ? String(r.target) : null,
          title: String(r.title),
          rationale: String(r.rationale),
          suggested_change: r.suggested_change,
          evidence: r.evidence ?? null,
          severity: String(r.severity ?? "info"),
        }))
      );
    }
    return { generated: toInsert.length, evaluated: recs.length };
  });

export const listRecommendations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("optimization_recommendations")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(200);
    return { recommendations: data ?? [] };
  });

export const decideRecommendation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    id: z.string().uuid(),
    action: z.enum(["approve", "reject"]),
    note: z.string().max(500).optional(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: rec } = await context.supabase
      .from("optimization_recommendations")
      .select("*")
      .eq("user_id", context.userId)
      .eq("id", data.id)
      .maybeSingle();
    if (!rec) throw new Error("Recommendation not found");
    if (rec.status !== "pending") throw new Error("Already decided");

    const newStatus = data.action === "approve" ? "approved" : "rejected";
    const patch: { status: string; reviewer_note: string | null; approved_at?: string; rejected_at?: string } = {
      status: newStatus,
      reviewer_note: data.note ?? null,
    };
    if (data.action === "approve") patch.approved_at = new Date().toISOString();
    else patch.rejected_at = new Date().toISOString();

    const { data: updated } = await context.supabase
      .from("optimization_recommendations")
      .update(patch)
      .eq("id", data.id)
      .eq("user_id", context.userId)
      .select()
      .single();

    await context.supabase.from("recommendation_audit").insert({
      user_id: context.userId,
      recommendation_id: data.id,
      action: data.action,
      note: data.note ?? null,
      before_state: rec,
      after_state: updated,
    });

    // Note: approval does NOT auto-apply. User must explicitly apply via the
    // relevant page (strategies, autonomous settings, etc.).
    return updated;
  });

// =============================================================================
// 8. Model Drift Monitoring
// =============================================================================
export const runDriftScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("trade_journal")
      .select("ai_confidence,realized_pnl,ai_regime,market_regime,created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(400);
    const rows = (data ?? []) as Row[];
    if (rows.length < 20) return { ok: false, reason: "insufficient_data" };

    const recent = rows.slice(0, Math.floor(rows.length / 2));
    const older = rows.slice(Math.floor(rows.length / 2));

    const accuracy = (arr: Row[]) => {
      if (!arr.length) return 0;
      return arr.filter(r => num(r.realized_pnl) > 0).length / arr.length;
    };
    const brier = (arr: Row[]) => {
      if (!arr.length) return 0;
      return arr.reduce((s, r) => {
        const c = num(r.ai_confidence);
        const outcome = num(r.realized_pnl) > 0 ? 1 : 0;
        return s + (c - outcome) ** 2;
      }, 0) / arr.length;
    };
    const distribution = (arr: Row[]) => {
      const regimes = new Map<string, number>();
      for (const r of arr) {
        const k = String(r.market_regime ?? "unknown");
        regimes.set(k, (regimes.get(k) ?? 0) + 1);
      }
      return regimes;
    };

    const recentAcc = accuracy(recent);
    const olderAcc = accuracy(older);
    const accDelta = recentAcc - olderAcc;
    const recentBrier = brier(recent);
    const dRecent = distribution(recent);
    const dOlder = distribution(older);
    const keys = new Set([...dRecent.keys(), ...dOlder.keys()]);
    let shift = 0;
    for (const k of keys) {
      const pr = (dRecent.get(k) ?? 0) / (recent.length || 1);
      const po = (dOlder.get(k) ?? 0) / (older.length || 1);
      shift += Math.abs(pr - po);
    }
    shift /= 2; // total variation distance

    const driftFlag = accDelta < -0.1 || recentBrier > 0.3 || shift > 0.3;
    const reason = [
      accDelta < -0.1 ? `accuracy dropped ${(accDelta * 100).toFixed(1)}%` : null,
      recentBrier > 0.3 ? `brier score ${recentBrier.toFixed(2)} (poor calibration)` : null,
      shift > 0.3 ? `market regime distribution shifted ${(shift * 100).toFixed(1)}%` : null,
    ].filter(Boolean).join("; ") || "no drift";

    const { data: inserted } = await supabase.from("model_drift_snapshots").insert({
      user_id: userId,
      model: "ai_engine_primary",
      window_days: 30,
      sample_size: rows.length,
      accuracy: recentAcc,
      brier: recentBrier,
      calibration_error: Math.abs(recentAcc - mean(recent.map(r => num(r.ai_confidence)))),
      accuracy_delta: accDelta,
      distribution_shift: shift,
      drift_flag: driftFlag,
      drift_reason: reason,
      details: { recent_acc: recentAcc, older_acc: olderAcc },
    }).select().single();

    return inserted;
  });

export const getDriftHistory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("model_drift_snapshots")
      .select("*")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    return { snapshots: data ?? [] };
  });

// =============================================================================
// 9. Executive Scorecard
// =============================================================================
export const getExecutiveScorecard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [healthR, driftR, recsR, journalR, calibR] = await Promise.all([
      context.supabase.from("strategy_health_scores").select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(100),
      context.supabase.from("model_drift_snapshots").select("*").eq("user_id", context.userId).order("created_at", { ascending: false }).limit(1),
      context.supabase.from("optimization_recommendations").select("severity,status").eq("user_id", context.userId).eq("status", "pending"),
      context.supabase.from("trade_journal").select("realized_pnl,created_at").eq("user_id", context.userId).order("created_at", { ascending: true }).limit(1000),
      context.supabase.from("capital_snapshots").select("equity,snapshot_date").eq("user_id", context.userId).order("snapshot_date", { ascending: true }).limit(180),
    ]);

    const latestHealth = new Map<string, Row>();
    for (const h of (healthR.data ?? []) as Row[]) {
      const k = String(h.strategy_id);
      if (!latestHealth.has(k)) latestHealth.set(k, h);
    }
    const leaderboard = Array.from(latestHealth.values()).sort((a, b) => num(b.score) - num(a.score));

    const journal = (journalR.data ?? []) as Row[];
    const pnls = journal.map(r => num(r.realized_pnl));
    const wins = pnls.filter(p => p > 0).length;
    const cum: number[] = [];
    pnls.reduce((a, b, i) => { cum[i] = a + b; return cum[i]; }, 0);

    const currentEdge = pnls.length ? mean(pnls) : 0;
    const sh = sharpe(pnls);
    const dd = maxDrawdown(cum);
    const winRate = pnls.length ? wins / pnls.length : 0;

    const aiScorecard = {
      health_avg: leaderboard.length ? mean(leaderboard.map(l => num(l.score))) : 0,
      drift_flag: (driftR.data ?? [])[0]?.drift_flag ?? false,
      pending_recommendations: (recsR.data ?? []).length,
      high_severity_recs: ((recsR.data ?? []) as Row[]).filter(r => r.severity === "high").length,
    };

    return {
      aiScorecard,
      strategyLeaderboard: leaderboard,
      currentEdge: {
        avg_pnl_per_trade: currentEdge,
        sharpe: sh,
        max_drawdown: dd,
        win_rate: winRate,
        sample: pnls.length,
      },
      performanceTimeline: (calibR.data ?? []).map((c: Row) => ({ date: c.snapshot_date, equity: num(c.equity) })),
    };
  });
