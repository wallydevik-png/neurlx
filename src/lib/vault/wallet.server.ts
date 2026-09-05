// NeurlX Trading Vault — server-only custody layer.
//
// KEY HANDLING (documented deliberately; read before changing anything here):
//   * Generation:  a fresh ed25519 keypair is created server-side with
//                  `Keypair.generate()` (Web Crypto RNG). No seed phrase is
//                  ever produced, shown, or transmitted.
//   * Encryption:  the 64-byte secret key is base58-encoded and sealed with
//                  AES-256-GCM via `encryptJSON` (key derived from the
//                  server-only CREDENTIAL_ENC_KEY secret).
//   * Storage:     ciphertext only, in `public.vault_wallets`, a table with
//                  RLS enabled and NO policies — unreachable from the browser
//                  under any session. Only trusted server code holding the
//                  service role can read it.
//   * Access:      decrypted in memory inside these handlers, solely to sign a
//                  single transaction, and never returned to a caller. No
//                  server function exposes the secret, the ciphertext, or any
//                  derivation of it.
//   * Isolation:   every read/write below is filtered by `user_id`. One user's
//                  keypair can never sign for, or spend, another user's funds.
import type { SupabaseClient } from "@supabase/supabase-js";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { encryptJSON, decryptJSON } from "@/lib/crypto.server";
import { rpcEndpoints, solBalance, tokenBalance, confirmSignature } from "@/lib/memecoin/jupiter.server";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** SOL kept back for rent + network fees; never withdrawable or tradeable. */
export { FEE_RESERVE_SOL as SOL_FEE_RESERVE } from "./funding.server";
import { FEE_RESERVE_SOL, computeAvailableSol, activeReservationsSol } from "./funding.server";

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const errors: string[] = [];
  for (const url of rpcEndpoints()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) { errors.push(`HTTP ${res.status}`); continue; }
      const json = await res.json() as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
      return json.result as T;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Solana RPC ")) throw e;
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(`Solana RPC ${method} failed on all endpoints (${errors.join("; ")})`);
}

export interface VaultWallet { userId: string; publicKey: string; createdAt: string }

type AdminClient = SupabaseClient;

async function admin(): Promise<AdminClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as AdminClient;
}

/** The user's vault wallet, creating one on first use. Never returns key material. */
export async function ensureVaultWallet(userId: string): Promise<VaultWallet> {
  const db = await admin();
  const { data: existing } = await db.from("vault_wallets")
    .select("user_id,public_key,created_at").eq("user_id", userId).maybeSingle();
  if (existing) {
    return { userId, publicKey: existing.public_key, createdAt: existing.created_at };
  }
  const kp = Keypair.generate();
  const ciphertext = await encryptJSON({ secret: bs58.encode(kp.secretKey) });
  const { error } = await db.from("vault_wallets").insert({
    user_id: userId, public_key: kp.publicKey.toBase58(), encrypted_secret: ciphertext,
  });
  if (error) {
    // Concurrent first-load: another request created it. Re-read rather than
    // ever overwriting an existing key (that would strand real funds).
    const { data: raced } = await db.from("vault_wallets")
      .select("user_id,public_key,created_at").eq("user_id", userId).maybeSingle();
    if (!raced) throw new Error(`Could not create trading vault: ${error.message}`);
    return { userId, publicKey: raced.public_key, createdAt: raced.created_at };
  }
  return { userId, publicKey: kp.publicKey.toBase58(), createdAt: new Date().toISOString() };
}

export async function getVaultWallet(userId: string): Promise<VaultWallet | null> {
  const db = await admin();
  const { data } = await db.from("vault_wallets")
    .select("user_id,public_key,created_at").eq("user_id", userId).maybeSingle();
  return data ? { userId, publicKey: data.public_key, createdAt: data.created_at } : null;
}

/**
 * Decrypt this user's signing key. Scoped by user_id on purpose — there is no
 * code path that loads a keypair without a user id, so cross-user signing is
 * structurally impossible.
 */
export async function loadVaultKeypair(userId: string): Promise<Keypair> {
  const db = await admin();
  const { data } = await db.from("vault_wallets")
    .select("encrypted_secret,public_key").eq("user_id", userId).maybeSingle();
  if (!data?.encrypted_secret) throw new Error("No trading vault wallet exists for this account.");
  const { secret } = await decryptJSON<{ secret: string }>(data.encrypted_secret);
  const kp = Keypair.fromSecretKey(bs58.decode(secret));
  if (kp.publicKey.toBase58() !== data.public_key) {
    throw new Error("Vault key integrity check failed — refusing to sign.");
  }
  return kp;
}

export interface VaultBalances {
  sol: number;
  usdc: number;
  reservedSol: number;
  availableSol: number;
  error: string | null;
}

/** On-chain balances plus the portion already committed to open positions. */
export async function vaultBalances(
  supabase: SupabaseClient, userId: string, publicKey: string,
): Promise<VaultBalances> {
  let sol = 0, usdc = 0;
  let error: string | null = null;
  const [solRes, usdcRes] = await Promise.allSettled([
    solBalance(publicKey),
    tokenBalance(publicKey, USDC_MINT),
  ]);
  if (solRes.status === "fulfilled") sol = solRes.value;
  else error = solRes.reason instanceof Error ? solRes.reason.message : "Solana RPC unavailable";
  if (usdcRes.status === "fulfilled") usdc = usdcRes.value.amount / 10 ** (usdcRes.value.decimals || USDC_DECIMALS);

  const { data: open } = await supabase.from("memecoin_positions")
    .select("amount_sol").eq("user_id", userId).eq("status", "open");
  const reservedSol = (open ?? []).reduce((a, p) => a + Number(p.amount_sol ?? 0), 0);

  return {
    sol, usdc, reservedSol,
    availableSol: Math.max(0, sol - reservedSol - SOL_FEE_RESERVE),
    error,
  };
}

async function sendSigned(tx: Transaction, kp: Keypair): Promise<string> {
  const { value } = await rpc<{ value: { blockhash: string } }>(
    "getLatestBlockhash", [{ commitment: "confirmed" }],
  );
  tx.recentBlockhash = value.blockhash;
  tx.feePayer = kp.publicKey;
  tx.sign(kp);
  const encoded = btoa(String.fromCharCode(...tx.serialize()));
  const signature = await rpc<string>("sendTransaction", [
    encoded, { encoding: "base64", maxRetries: 3, preflightCommitment: "confirmed" },
  ]);
  await confirmSignature(signature);
  return signature;
}

/** Transfer SOL out of the vault to an arbitrary destination address. */
export async function withdrawSol(userId: string, destination: string, amount: number): Promise<string> {
  const kp = await loadVaultKeypair(userId);
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: kp.publicKey,
    toPubkey: new PublicKey(destination),
    lamports: Math.floor(amount * 1e9),
  }));
  return sendSigned(tx, kp);
}

/** Transfer USDC out of the vault, creating the destination token account if needed. */
export async function withdrawUsdc(userId: string, destination: string, amount: number): Promise<string> {
  const kp = await loadVaultKeypair(userId);
  const mint = new PublicKey(USDC_MINT);
  const dest = new PublicKey(destination);
  const fromAta = await getAssociatedTokenAddress(mint, kp.publicKey);
  const toAta = await getAssociatedTokenAddress(mint, dest);

  const tx = new Transaction();
  const info = await rpc<{ value: unknown }>("getAccountInfo", [toAta.toBase58(), { encoding: "base64" }]);
  if (!info?.value) {
    tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, toAta, dest, mint));
  }
  tx.add(createTransferCheckedInstruction(
    fromAta, mint, toAta, kp.publicKey,
    BigInt(Math.floor(amount * 10 ** USDC_DECIMALS)), USDC_DECIMALS, [], TOKEN_PROGRAM_ID,
  ));
  return sendSigned(tx, kp);
}

export function isSolanaAddress(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  try { new PublicKey(value); return true; } catch { return false; }
}

export async function hashCode(userId: string, code: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(`neurlx-withdrawal:${userId}:${code}`),
  );
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Append to the immutable vault ledger. Never throws into the caller path. */
export async function recordVaultTx(
  userId: string,
  entry: { kind: string; asset?: string; amount: number; signature?: string | null; status?: string; detail?: Record<string, unknown> },
): Promise<void> {
  try {
    const db = await admin();
    await db.from("vault_transactions").insert({
      user_id: userId,
      kind: entry.kind,
      asset: entry.asset ?? "SOL",
      amount: entry.amount,
      signature: entry.signature ?? null,
      status: entry.status ?? "confirmed",
      detail: entry.detail ?? {},
    });
  } catch (e) {
    console.error("[vault] ledger write failed", e);
  }
}

export interface ChainTx { signature: string; slot: number; time: string | null; err: boolean }

/** Recent on-chain activity for the vault address (deposits included). */
export async function recentChainActivity(publicKey: string, limit = 25): Promise<ChainTx[]> {
  try {
    const rows = await rpc<Array<{ signature: string; slot: number; blockTime: number | null; err: unknown }>>(
      "getSignaturesForAddress", [publicKey, { limit }],
    );
    return (rows ?? []).map(r => ({
      signature: r.signature,
      slot: r.slot,
      time: r.blockTime ? new Date(r.blockTime * 1000).toISOString() : null,
      err: Boolean(r.err),
    }));
  } catch {
    return [];
  }
}
