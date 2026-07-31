// Server functions backing the Portfolio Intelligence dashboard.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export interface PortfolioIntelSnapshot {
  equity: number;
  mode: string;
  healthScore: number;
  health: Record<string, number>;
  notes: string[];
  sectorExposure: Record<string, number>;
  open: { symbol: string; side: string; riskPct: number; notional: number }[];
  constraints: { minScore: number; minConfidence: number; maxOpenTrades: number | null; sizeMultiplier: number };
  drawdownPct: number;
  expectedMonthlyReturn: number;
  worstCaseProjection: number;
  expectedDrawdown: number;
}

export const getPortfolioIntel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { loadPortfolioContext } = await import("@/lib/portfolioIntel/manager.server");
    const ctx = await loadPortfolioContext(supabase, userId);

    const [health, decisions, regimes, quality, contributions, proposals] = await Promise.all([
      supabase.from("portfolio_health_snapshots").select("*")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(60),
      supabase.from("portfolio_decisions").select("*")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
      supabase.from("market_regime_snapshots").select("*")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
      supabase.from("trade_quality_scores").select("grade,overall,symbol,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(300),
      supabase.from("positions").select("strategy_id,realized_pnl")
        .eq("user_id", userId).eq("status", "closed").limit(500),
      supabase.from("capital_engine_params").select("*")
        .eq("user_id", userId).order("version", { ascending: false }).limit(5),
    ]);

    const gradeCounts: Record<string, number> = {};
    for (const q of quality.data ?? []) gradeCounts[q.grade as string] = (gradeCounts[q.grade as string] ?? 0) + 1;

    const contribMap = new Map<string, number>();
    for (const p of contributions.data ?? []) {
      const k = (p.strategy_id as string | null) ?? "unassigned";
      contribMap.set(k, (contribMap.get(k) ?? 0) + Number(p.realized_pnl ?? 0));
    }
    const { data: strategyRows } = await supabase.from("strategies")
      .select("id,name,lifecycle_state,score").eq("user_id", userId);
    const strategyContributions = [...contribMap.entries()].map(([id, pnl]) => {
      const s = (strategyRows ?? []).find(r => r.id === id);
      return {
        id, name: s?.name ?? "Unassigned", pnl: +pnl.toFixed(2),
        state: (s?.lifecycle_state as string | null) ?? "n/a",
        score: Number(s?.score ?? 0),
      };
    }).sort((a, b) => b.pnl - a.pnl);

    const snapshot: PortfolioIntelSnapshot = {
      equity: ctx.equity,
      mode: ctx.mode,
      healthScore: ctx.health.healthScore,
      health: {
        heat: ctx.health.heat,
        riskConcentration: ctx.health.riskConcentration,
        capitalUtilization: ctx.health.capitalUtilization,
        correlationScore: ctx.health.correlationScore,
        volatility: ctx.health.volatility,
        diversificationScore: ctx.health.diversificationScore,
        recoveryFactor: ctx.health.recoveryFactor,
      },
      notes: ctx.health.notes,
      sectorExposure: ctx.health.sectorExposure,
      open: ctx.open.map(o => ({ symbol: o.symbol, side: o.side, riskPct: o.riskPct, notional: +o.notional.toFixed(2) })),
      constraints: {
        minScore: ctx.constraints.minScore,
        minConfidence: ctx.constraints.minConfidence,
        maxOpenTrades: ctx.constraints.maxOpenTrades,
        sizeMultiplier: ctx.constraints.sizeMultiplier,
      },
      drawdownPct: +(ctx.drawdownPct * 100).toFixed(2),
      expectedMonthlyReturn: ctx.health.expectedMonthlyReturn,
      worstCaseProjection: ctx.health.worstCaseProjection,
      expectedDrawdown: ctx.health.expectedDrawdown,
    };

    return {
      snapshot,
      settings: {
        pmEnabled: ctx.settings["pm_enabled"] !== false,
        pmMinScore: Number(ctx.settings["pm_min_score"] ?? 75),
        maxCryptoBeta: Number(ctx.settings["max_crypto_beta"] ?? 6),
        aggressiveEnabled: ctx.settings["aggressive_mode_enabled"] !== false,
        sectorLimits: (ctx.settings["sector_limits"] ?? {}) as Record<string, number>,
        overtradingWindow: Number(ctx.settings["overtrading_window_minutes"] ?? 30),
        overtradingMax: Number(ctx.settings["overtrading_max_trades"] ?? 3),
        overtradingMinScore: Number(ctx.settings["overtrading_min_score"] ?? 95),
      },
      healthHistory: (health.data ?? []).map(h => ({
        at: h.created_at as string,
        score: Number(h.health_score), heat: Number(h.heat),
        mode: h.portfolio_mode as string,
        expectedDrawdown: Number(h.expected_drawdown),
      })).reverse(),
      decisions: (decisions.data ?? []).map(d => ({
        id: d.id as string, at: d.created_at as string, symbol: d.symbol as string,
        side: d.side as string, score: Number(d.score), allocation: Number(d.allocation_pct),
        riskPct: Number(d.risk_pct), approved: !!d.approved,
        rejectReason: (d.reject_reason as string | null) ?? null,
        regime: (d.regime as string | null) ?? null, mode: d.portfolio_mode as string,
        components: (d.components ?? {}) as Record<string, number>,
        notes: (d.notes ?? []) as string[],
      })),
      regimes: (regimes.data ?? []).map(r => ({
        at: r.created_at as string, symbol: r.symbol as string, regime: r.regime as string,
        label: (r.label as string | null) ?? r.regime as string,
        confidence: Number(r.confidence), tradable: !!r.tradable,
      })),
      gradeCounts,
      strategyContributions,
      capitalProposals: (proposals.data ?? []).map(p => ({
        id: p.id as string, version: Number(p.version), status: p.status as string,
        at: p.created_at as string,
        allocationPct: Number(p.optimal_allocation_pct ?? 0),
        stopAtrMult: Number(p.optimal_stop_atr_mult ?? 0),
        tpRMultiple: Number(p.optimal_tp_r_multiple ?? 0),
        holdingMinutes: Number(p.optimal_holding_minutes ?? 0),
        trailingPct: Number(p.optimal_trailing_pct ?? 0),
        metrics: (p.metrics ?? {}) as Record<string, number>,
      })),
    };
  });

const SettingsSchema = z.object({
  pmEnabled: z.boolean().optional(),
  pmMinScore: z.number().min(50).max(100).optional(),
  maxCryptoBeta: z.number().min(0).max(50).optional(),
  aggressiveEnabled: z.boolean().optional(),
  sectorLimits: z.record(z.string(), z.number().min(0).max(100)).optional(),
  overtradingWindow: z.number().min(1).max(720).optional(),
  overtradingMax: z.number().min(1).max(50).optional(),
  overtradingMinScore: z.number().min(50).max(100).optional(),
});

export const updatePortfolioIntelSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.pmEnabled !== undefined) patch["pm_enabled"] = data.pmEnabled;
    if (data.pmMinScore !== undefined) patch["pm_min_score"] = data.pmMinScore;
    if (data.maxCryptoBeta !== undefined) patch["max_crypto_beta"] = data.maxCryptoBeta;
    if (data.aggressiveEnabled !== undefined) patch["aggressive_mode_enabled"] = data.aggressiveEnabled;
    if (data.sectorLimits !== undefined) patch["sector_limits"] = data.sectorLimits;
    if (data.overtradingWindow !== undefined) patch["overtrading_window_minutes"] = data.overtradingWindow;
    if (data.overtradingMax !== undefined) patch["overtrading_max_trades"] = data.overtradingMax;
    if (data.overtradingMinScore !== undefined) patch["overtrading_min_score"] = data.overtradingMinScore;
    if (Object.keys(patch).length === 0) return { ok: true };
    const { error } = await context.supabase.from("automation_settings")
      .update(patch).eq("user_id", context.userId);
    if (error) throw error;
    return { ok: true };
  });

/** Recompute health, regimes, trade grades and capital proposals on demand. */
export const refreshPortfolioIntel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const {
      loadPortfolioContext, snapshotHealth, gradeClosedTrades, runCapitalEngine, recordRegime,
    } = await import("@/lib/portfolioIntel/manager.server");
    const { getMacroRegime } = await import("@/lib/portfolioIntel/regime.server");
    const ctx = await loadPortfolioContext(supabase, userId);
    await snapshotHealth(supabase, userId, ctx);
    const graded = await gradeClosedTrades(supabase, userId);
    const capital = await runCapitalEngine(supabase, userId);

    const symbols = [...new Set(ctx.open.map(o => o.symbol))].slice(0, 6);
    const list = symbols.length ? symbols : ["BTC-USD", "ETH-USD"];
    const regimes: { symbol: string; regime: string; label: string }[] = [];
    for (const s of list) {
      try {
        const r = await getMacroRegime(supabase, s);
        await recordRegime(supabase, userId, r);
        regimes.push({ symbol: s, regime: r.regime, label: r.label });
      } catch { /* skip unavailable market */ }
    }
    return {
      healthScore: ctx.health.healthScore, mode: ctx.mode,
      graded: graded.graded, capitalVersion: capital.version ?? null, regimes,
    };
  });

/** Live correlation matrix for the open book plus a watchlist. */
export const getCorrelationMatrix = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { assumedCorrelation } = await import("@/lib/portfolioIntel/sectors");
    const { data } = await context.supabase.from("positions").select("symbol")
      .eq("user_id", context.userId).eq("status", "open");
    const symbols = [...new Set((data ?? []).map(p => p.symbol as string))];
    if (symbols.length < 2) return { symbols, matrix: [] as number[][] };
    const matrix = symbols.map(a => symbols.map(b => +assumedCorrelation(a, b).toFixed(2)));
    return { symbols, matrix };
  });
