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
  // htf_conflict severity buckets. Stored alongside the funnel stages so the
  // breakdown and the funnel are literally the same dataset; hidden from the
  // funnel list itself to avoid double counting htf_conflict.
  "htf_agree_0",
  "htf_agree_1",
  "htf_agree_2",
  "other",
] as const;
const HTF_BUCKET_STAGES = ["htf_agree_0", "htf_agree_1", "htf_agree_2"] as const;
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
    } else if (e.startsWith("htf_agree:")) {
      for (const m of e.matchAll(/([0-2])=(\d+)/g)) add(`htf_agree_${m[1]}`, Number(m[2]) || 0);
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

export interface HtfSeverityBreakdown {
  days: number;
  total: number;
  buckets: Array<{ agree: number; label: string; count: number; share: number }>;
}

/**
 * htf_conflict rejections split by how many higher timeframes agreed with the
 * proposed direction. Parsed from the cycle logs in autonomous_runs, which
 * carry the "X/3 agree with BUY" detail per rejected candidate.
 */
export async function loadHtfSeverityBreakdown(
  supabase: SupabaseClient,
  userId: string,
  days = 7,
): Promise<HtfSeverityBreakdown> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data } = await supabase.from("autonomous_runs")
    .select("errors").eq("user_id", userId).gte("started_at", since).limit(5000);
  const counts = [0, 0, 0];
  for (const row of data ?? []) {
    const errs = (row as { errors: unknown }).errors;
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      if (typeof e !== "string" || !e.startsWith("htf_conflict")) continue;
      for (const m of e.matchAll(/([0-3])\/3 agree with/g)) {
        const n = Number(m[1]);
        if (n >= 0 && n <= 2) counts[n]++;
      }
    }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  const labels = [
    "full contradiction",
    "partial contradiction",
    "near-miss, one timeframe against",
  ];
  return {
    days,
    total,
    buckets: counts.map((count, agree) => ({
      agree, label: labels[agree]!, count, share: total > 0 ? count / total : 0,
    })),
  };
}
