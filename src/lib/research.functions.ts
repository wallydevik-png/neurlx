// Research Lab server functions — CRUD hypotheses and evaluate them.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { emptyDSL, validateDSL, type HypothesisDSL } from "./research/dsl";
import { FACTORS } from "./research/factors";
import { listSupportedSymbols } from "./marketdata/symbols";

export interface HypothesisRow {
  id: string;
  name: string;
  description: string | null;
  symbol: string;
  interval: string;
  dsl: HypothesisDSL;
  tags: string[];
  status: "draft" | "validated" | "rejected" | "promoted";
  last_metrics: any | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export const listFactors = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => ({
    factors: FACTORS.map(f => ({
      id: f.id, label: f.label, category: f.category, description: f.description,
      unit: f.unit ?? null, params: f.params,
    })),
    symbols: listSupportedSymbols(),
    template: emptyDSL(),
  }));

export const listHypotheses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: HypothesisRow[] }> => {
    const supabase = context.supabase as any;
    const { data, error } = await supabase.from("research_hypotheses")
      .select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as HypothesisRow[] };
  });

const CreateIn = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  symbol: z.string().min(1).max(32),
  interval: z.enum(["5m", "15m", "1h", "4h", "1d"]).default("1h"),
  tags: z.array(z.string().max(32)).max(12).default([]),
  dsl: z.any(),
});

export const createHypothesis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => CreateIn.parse(d))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const v = validateDSL(data.dsl);
    if (!v.ok) throw new Error(v.error);
    const supabase = context.supabase as any;
    const { data: row, error } = await supabase.from("research_hypotheses").insert({
      user_id: context.userId,
      name: data.name,
      description: data.description ?? null,
      symbol: data.symbol,
      interval: data.interval,
      tags: data.tags,
      dsl: v.dsl,
      status: "draft",
    }).select("id").single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

const UpdateIn = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  tags: z.array(z.string().max(32)).max(12).optional(),
  status: z.enum(["draft", "validated", "rejected", "promoted"]).optional(),
  dsl: z.any().optional(),
});

export const updateHypothesis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => UpdateIn.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const patch: Record<string, any> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;
    if (data.tags !== undefined) patch.tags = data.tags;
    if (data.status !== undefined) patch.status = data.status;
    if (data.dsl !== undefined) {
      const v = validateDSL(data.dsl);
      if (!v.ok) throw new Error(v.error);
      patch.dsl = v.dsl;
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    const supabase = context.supabase as any;
    const { error } = await supabase.from("research_hypotheses").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const DeleteIn = z.object({ id: z.string().uuid() });
export const deleteHypothesis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => DeleteIn.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const supabase = context.supabase as any;
    const { error } = await supabase.from("research_hypotheses").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const EvalIn = z.object({ id: z.string().uuid(), bars: z.number().int().min(120).max(1000).optional() });
export const evaluateHypothesis = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => EvalIn.parse(d))
  .handler(async ({ data, context }) => {
    const supabase = context.supabase as any;
    const { data: row, error } = await supabase.from("research_hypotheses")
      .select("*").eq("id", data.id).single();
    if (error) throw new Error(error.message);
    const v = validateDSL(row.dsl);
    if (!v.ok) throw new Error(v.error);
    const { runHypothesis } = await import("./research/runner.server");
    const run = await runHypothesis(supabase, {
      symbol: row.symbol,
      interval: row.interval as any,
      bars: data.bars ?? 400,
      dsl: v.dsl,
    });
    // Persist compact summary
    const summary = {
      trades: run.trades, winRate: run.winRate, totalReturnPct: run.totalReturnPct,
      sharpe: run.metrics.sharpe, sortino: run.metrics.sortino,
      maxDrawdownPct: run.metrics.maxDrawdownPct, profitFactor: run.metrics.profitFactor,
      expectancy: run.metrics.expectancy,
    };
    await supabase.from("research_hypotheses").update({
      last_metrics: summary, last_run_at: new Date().toISOString(),
    }).eq("id", data.id);
    return { run, summary };
  });
