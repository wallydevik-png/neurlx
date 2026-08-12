// Rolling rejection-stage telemetry.
//
// Every cycle logs individual rejection strings, but the useful question is
// "which gate is the bottleneck?". This module folds a cycle's errors and
// reject reasons into coarse pipeline stages and accumulates them per UTC day
// in public.rejection_stage_stats, so the UI can show a 7-day breakdown.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Pipeline stages, in execution order. */
export const REJECTION_STAGES = [
  "entry_momentum_no_candidates",
  "htf_conflict",
  "committee_no_trade",
  "below_min_confidence",
  "asset_not_allowed",
  "entry_filter",
  "lifecycle_gate",
  "portfolio_manager",
  "risk_gate",
  "execution_intel",
  "sizing",
  "wallet",
  "policy",
  "no_open_slots",
  "other",
] as const;
export type RejectionStage = (typeof REJECTION_STAGES)[number];

function stageOfKey(key: string): RejectionStage {
  const head = key.split(":")[0] ?? key;
  return (REJECTION_STAGES as readonly string[]).includes(head)
    ? (head as RejectionStage)
    : "other";
}

/** Fold one cycle's telemetry into per-stage counts. */
export function summarizeCycle(
  errors: string[],
  rejectReasons: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (stage: string, n: number) => { out[stage] = (out[stage] ?? 0) + n; };

  for (const [key, n] of Object.entries(rejectReasons ?? {})) {
    add(stageOfKey(key), Number(n) || 0);
  }
  for (const e of errors ?? []) {
    if (e.startsWith("entry_momentum_no_candidates")) add("entry_momentum_no_candidates", 1);
    else if (e.startsWith("htf_conflict")) {
      const m = /htf_conflict:(\d+)_candidates/.exec(e);
      add("htf_conflict", m ? Number(m[1]) : 1);
    } else if (e.startsWith("committee_no_trade")) add("committee_no_trade", 1);
  }
  return out;
}

/** Accumulate one cycle into today's rolling counters. */
export async function recordRejectionStages(
  supabase: SupabaseClient,
  userId: string,
  errors: string[],
  rejectReasons: Record<string, number>,
): Promise<void> {
  const counts = summarizeCycle(errors, rejectReasons);
  const stages = Object.keys(counts);
  if (!stages.length) return;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const { data: existing } = await supabase.from("rejection_stage_stats")
      .select("stage,count").eq("user_id", userId).eq("day", day).in("stage", stages);
    const prev = new Map((existing ?? []).map(r => [r.stage as string, Number(r.count) || 0]));
    await supabase.from("rejection_stage_stats").upsert(
      stages.map(stage => ({
        user_id: userId, day, stage,
        count: (prev.get(stage) ?? 0) + counts[stage],
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "user_id,day,stage" },
    );
  } catch {
    // Telemetry must never break a trading cycle.
  }
}

export interface RejectionBreakdown {
  days: number;
  total: number;
  stages: Array<{ stage: string; count: number; share: number }>;
  bottleneck: string | null;
}

/** Rolling breakdown over the last `days` UTC days (default 7). */
export async function loadRejectionBreakdown(
  supabase: SupabaseClient,
  userId: string,
  days = 7,
): Promise<RejectionBreakdown> {
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { data } = await supabase.from("rejection_stage_stats")
    .select("stage,count").eq("user_id", userId).gte("day", from);
  const totals = new Map<string, number>();
  for (const r of data ?? []) {
    totals.set(r.stage as string, (totals.get(r.stage as string) ?? 0) + (Number(r.count) || 0));
  }
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  const stages = [...totals.entries()]
    .map(([stage, count]) => ({ stage, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);
  return { days, total, stages, bottleneck: stages[0]?.stage ?? null };
}
