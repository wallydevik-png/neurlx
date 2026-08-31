// Withdrawal protection policy: daily caps and a first-use cooldown on new
// destination addresses.
//
// Design note — why limit changes are asymmetric: a policy a stolen session
// can raise instantly is not a limit. Lowering a cap (or lengthening the
// cooldown) applies immediately; loosening either one is staged and only takes
// effect after LOOSEN_DELAY_MS.
import type { SupabaseClient } from "@supabase/supabase-js";

export const LOOSEN_DELAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_POLICY = {
  dailyLimitSol: 2,
  dailyLimitUsdc: 500,
  cooldownMinutes: 1440,
};

export interface PolicyRow {
  daily_limit_sol: number | string;
  daily_limit_usdc: number | string;
  new_address_cooldown_minutes: number;
  pending_daily_limit_sol: number | string | null;
  pending_daily_limit_usdc: number | string | null;
  pending_cooldown_minutes: number | null;
  pending_effective_at: string | null;
}

export interface EffectivePolicy {
  dailyLimitSol: number;
  dailyLimitUsdc: number;
  cooldownMinutes: number;
  pending: null | {
    dailyLimitSol: number;
    dailyLimitUsdc: number;
    cooldownMinutes: number;
    effectiveAt: string;
  };
}

/** Pure: which limits are in force right now, given a stored row. */
export function effectivePolicy(row: PolicyRow | null, now = Date.now()): EffectivePolicy {
  if (!row) return { ...DEFAULT_POLICY, pending: null };
  const base = {
    dailyLimitSol: Number(row.daily_limit_sol),
    dailyLimitUsdc: Number(row.daily_limit_usdc),
    cooldownMinutes: Number(row.new_address_cooldown_minutes),
  };
  const at = row.pending_effective_at ? new Date(row.pending_effective_at).getTime() : null;
  if (at == null) return { ...base, pending: null };
  const staged = {
    dailyLimitSol: Number(row.pending_daily_limit_sol ?? base.dailyLimitSol),
    dailyLimitUsdc: Number(row.pending_daily_limit_usdc ?? base.dailyLimitUsdc),
    cooldownMinutes: Number(row.pending_cooldown_minutes ?? base.cooldownMinutes),
  };
  if (now >= at) return { ...staged, pending: null };
  return { ...base, pending: { ...staged, effectiveAt: row.pending_effective_at! } };
}

/**
 * Pure: split a requested policy into the part that applies now (anything
 * that tightens security) and the part that must wait.
 */
export function splitPolicyChange(
  current: { dailyLimitSol: number; dailyLimitUsdc: number; cooldownMinutes: number },
  next: { dailyLimitSol: number; dailyLimitUsdc: number; cooldownMinutes: number },
) {
  const immediate = {
    dailyLimitSol: Math.min(current.dailyLimitSol, next.dailyLimitSol),
    dailyLimitUsdc: Math.min(current.dailyLimitUsdc, next.dailyLimitUsdc),
    cooldownMinutes: Math.max(current.cooldownMinutes, next.cooldownMinutes),
  };
  const loosens =
    next.dailyLimitSol > current.dailyLimitSol ||
    next.dailyLimitUsdc > current.dailyLimitUsdc ||
    next.cooldownMinutes < current.cooldownMinutes;
  return { immediate, staged: loosens ? next : null };
}

/** Pure: is this destination past its first-use cooldown? */
export function destinationUnlocked(unlocksAt: string | null, now = Date.now()): boolean {
  if (!unlocksAt) return false;
  return new Date(unlocksAt).getTime() <= now;
}

async function admin(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

export async function loadPolicy(userId: string): Promise<EffectivePolicy> {
  const db = await admin();
  const { data } = await db.from("vault_withdrawal_policy").select("*")
    .eq("user_id", userId).maybeSingle();
  if (!data) {
    await db.from("vault_withdrawal_policy").insert({ user_id: userId });
    return { ...DEFAULT_POLICY, pending: null };
  }
  return effectivePolicy(data as unknown as PolicyRow);
}

/** Sum of SOL/USDC that actually left the vault in the trailing 24h. */
export async function withdrawnLast24h(userId: string, asset: "SOL" | "USDC"): Promise<number> {
  const db = await admin();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await db.from("vault_withdrawals")
    .select("amount,status,created_at")
    .eq("user_id", userId).eq("asset", asset).gte("created_at", since);
  // Anything already sent, or mid-flight, counts against the cap.
  return (data ?? [])
    .filter(r => r.status === "sent" || r.status === "sending")
    .reduce((a, r) => a + Number(r.amount ?? 0), 0);
}

/**
 * Register the destination on first use and return when it becomes usable.
 * Never shortens an existing unlock time.
 */
export async function noteDestination(
  userId: string, address: string, cooldownMinutes: number,
): Promise<{ unlocksAt: string; isNew: boolean }> {
  const db = await admin();
  const { data: existing } = await db.from("vault_destinations")
    .select("unlocks_at").eq("user_id", userId).eq("address", address).maybeSingle();
  if (existing) return { unlocksAt: String(existing.unlocks_at), isNew: false };

  const unlocksAt = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
  const { error } = await db.from("vault_destinations")
    .insert({ user_id: userId, address, unlocks_at: unlocksAt });
  if (error) {
    // Concurrent first use — re-read rather than resetting the clock.
    const { data: raced } = await db.from("vault_destinations")
      .select("unlocks_at").eq("user_id", userId).eq("address", address).maybeSingle();
    if (raced) return { unlocksAt: String(raced.unlocks_at), isNew: false };
    throw new Error(`Could not register the destination address: ${error.message}`);
  }
  return { unlocksAt, isNew: true };
}

export function humanDelay(untilIso: string, now = Date.now()): string {
  const mins = Math.max(1, Math.ceil((new Date(untilIso).getTime() - now) / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = Math.ceil(mins / 60);
  return `${hrs} hour${hrs === 1 ? "" : "s"}`;
}
