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
  "htf",
  "committee_no_trade",
  "committee_no_majority",
  "committee_no_verdicts",
  "below_generation_confidence",
  "entry_momentum",
  "regime",
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
  // Semantic HTF classification buckets (replace the "N/3 agree" histogram).
  "htf_full_contradiction",
  "htf_partial_contradiction",
  "htf_near_miss",
  "htf_insufficient_data",
  "htf_unavailable",
  "other",
] as const;
const HTF_BUCKET_STAGES = ["htf_agree_0", "htf_agree_1", "htf_agree_2"] as const;
export const HTF_CLASS_STAGES = [
  "htf_full_contradiction",
  "htf_partial_contradiction",
  "htf_near_miss",
  "htf_insufficient_data",
  "htf_unavailable",
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
    } else if (e.startsWith("htf_agree:")) {
      for (const m of e.matchAll(/([0-2])=(\d+)/g)) add(`htf_agree_${m[1]}`, Number(m[2]) || 0);
    } else if (e.startsWith("htf_class:")) {
      for (const m of e.slice("htf_class:".length).split(",")) {
        const [cls, n] = m.split("=");
        if (cls) add(`htf_${cls}`, Number(n) || 0);
      }
    } else if (e.startsWith("committee_no_trade")) add("committee_no_trade", 1);
    else if (e.startsWith("committee_no_verdicts")) add("committee_no_verdicts", 1);
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
  // Severity buckets are stored in the same table but are a *sub-division* of
  // htf_conflict, so they must not inflate the funnel totals.
  for (const s of HTF_BUCKET_STAGES) totals.delete(s);
  // Classification buckets sub-divide the `htf` funnel stage — never inflate it.
  for (const s of HTF_CLASS_STAGES) totals.delete(s);
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  const stages = [...totals.entries()]
    .map(([stage, count]) => ({ stage, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);
  return { days, total, stages, bottleneck: stages[0]?.stage ?? null };
}

export interface HtfSeverityBreakdown {
  days: number;
  total: number;
  /** htf_conflict total from the funnel, for reconciliation with `total`. */
  conflictTotal: number;
  /** Rejected candidates the HTF budget never inspected (conflictTotal - total). */
  unmeasured: number;
  buckets: Array<{ agree: number; label: string; count: number; share: number }>;
}

/**
 * htf_conflict rejections split by how many higher timeframes agreed with the
 * proposed direction.
 *
 * Read from public.rejection_stage_stats — the SAME rolling counters that feed
 * the funnel — not by re-parsing cycle log text. The log line only ever carried
 * a 3-candidate sample, which is why the old parsed breakdown reported a small
 * fraction of the funnel's htf_conflict total.
 */
export async function loadHtfSeverityBreakdown(
  supabase: SupabaseClient,
  userId: string,
  days = 7,
): Promise<HtfSeverityBreakdown> {
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { data } = await supabase.from("rejection_stage_stats")
    .select("stage,count").eq("user_id", userId).gte("day", from)
    .in("stage", [...HTF_BUCKET_STAGES, "htf_conflict"]);
  const counts = [0, 0, 0];
  let conflictTotal = 0;
  for (const r of data ?? []) {
    const n = Number(r.count) || 0;
    const stage = r.stage as string;
    if (stage === "htf_conflict") conflictTotal += n;
    else {
      const idx = Number(stage.slice(-1));
      if (idx >= 0 && idx <= 2) counts[idx] += n;
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
    conflictTotal,
    unmeasured: Math.max(0, conflictTotal - total),
    buckets: counts.map((count, agree) => ({
      agree, label: labels[agree]!, count, share: total > 0 ? count / total : 0,
    })),
  };
}
