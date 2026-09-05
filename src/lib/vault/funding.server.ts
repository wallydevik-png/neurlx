// Vault funding: the single source of trading capital.
//
// The autonomous engine and the memecoin sniper spend ONLY from the user's
// NeurlX vault wallet. A linked/external wallet is a withdrawal destination
// and an ownership marker — never a funding source.
//
// Concurrency: two trades started at the same moment must not both see the
// same unspent SOL. `reserveVaultSol` therefore does the check-and-claim in
// one database round trip (`claim_vault_funds`, which takes a per-user
// advisory lock), and the caller releases the claim if the transaction fails.
// A reservation also expires on its own, so a crashed worker cannot strand
// funds forever.
import type { SupabaseClient } from "@supabase/supabase-js";

/** SOL kept back for rent + network fees; never tradeable or withdrawable. */
export const FEE_RESERVE_SOL = 0.003;

export interface AvailabilityInput {
  /** Confirmed on-chain SOL balance of the vault address. */
  sol: number;
  /** SOL committed to open positions. */
  positionsSol: number;
  /** SOL claimed by in-flight trade reservations. */
  reservationsSol: number;
  feeReserve?: number;
}

/** Pure: available = on-chain − reserved (positions + claims) − fee reserve. */
export function computeAvailableSol(i: AvailabilityInput): number {
  const fee = i.feeReserve ?? FEE_RESERVE_SOL;
  return Math.max(0, i.sol - i.positionsSol - i.reservationsSol - fee);
}

/** Pure: what a claim may draw against, before existing claims are subtracted. */
export function computeSpendableSol(
  sol: number, positionsSol: number, feeReserve = FEE_RESERVE_SOL,
): number {
  return Math.max(0, sol - positionsSol - feeReserve);
}

async function admin(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

/** SOL currently claimed by live (unexpired) reservations for this user. */
export async function activeReservationsSol(userId: string): Promise<number> {
  const db = await admin();
  const { data } = await db.from("vault_reservations")
    .select("amount_sol,expires_at")
    .eq("user_id", userId).eq("status", "active");
  const now = Date.now();
  return (data ?? [])
    .filter(r => new Date(String(r.expires_at)).getTime() > now)
    .reduce((a, r) => a + Number(r.amount_sol ?? 0), 0);
}

export interface Claim {
  id: string | null;
  granted: boolean;
  reserved: number;
  available: number;
}

/**
 * Atomically claim `amount` SOL of the vault's spendable balance.
 * Returns `granted: false` (never throws) when the funds are already spoken
 * for by another in-flight trade.
 */
export async function reserveVaultSol(
  userId: string, amount: number, spendable: number,
  opts: { purpose?: string; reference?: string } = {},
): Promise<Claim> {
  const db = await admin();
  const { data, error } = await db.rpc("claim_vault_funds", {
    _user_id: userId,
    _amount: amount,
    _spendable: spendable,
    _purpose: opts.purpose ?? "trade",
    _reference: opts.reference ?? null,
  });
  if (error) throw new Error(`Could not reserve vault funds: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    { id: string | null; granted: boolean; reserved: number; available: number } | undefined;
  if (!row) throw new Error("Could not reserve vault funds");
  return {
    id: row.id ?? null,
    granted: Boolean(row.granted),
    reserved: Number(row.reserved ?? 0),
    available: Number(row.available ?? 0),
  };
}

/**
 * Release a claim. `consumed` marks funds that actually moved on-chain
 * (the position now carries the exposure); `released` returns them to the
 * available pool after a failed or abandoned trade.
 */
export async function releaseVaultSol(
  userId: string, reservationId: string, status: "released" | "consumed" = "released",
): Promise<boolean> {
  const db = await admin();
  const { data, error } = await db.rpc("release_vault_funds", {
    _user_id: userId, _reservation_id: reservationId, _status: status,
  });
  if (error) return false;
  return Boolean(data);
}
