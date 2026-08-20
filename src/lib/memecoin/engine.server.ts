// Memecoin sniper engine: scan -> gate -> execute -> manage exits.
import type { SupabaseClient } from "@supabase/supabase-js";
import { scanMemecoins, priceForMint, aiThesis, type MemeCandidate } from "./scanner.server";
import { swap, tokenBalance, solBalance, SOL_MINT } from "./jupiter.server";
import { decryptJSON } from "@/lib/crypto.server";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DB = SupabaseClient<any, any, any>;

export type MemeSettings = {
  enabled: boolean; autotrade: boolean; buy_amount_sol: number; max_open_positions: number;
  take_profit_pct: number; stop_loss_pct: number; trailing_stop_pct: number;
  min_liquidity_usd: number; min_score: number; slippage_bps: number; max_daily_loss_sol: number;
};

const DEFAULTS: MemeSettings = {
  enabled: false, autotrade: false, buy_amount_sol: 0.05, max_open_positions: 3,
  take_profit_pct: 60, stop_loss_pct: 25, trailing_stop_pct: 20,
  min_liquidity_usd: 25000, min_score: 70, slippage_bps: 300, max_daily_loss_sol: 0.25,
};

export async function loadSettings(db: DB, userId: string): Promise<MemeSettings> {
  const { data } = await db.from("memecoin_settings").select("*").eq("user_id", userId).maybeSingle();
  if (!data) {
    await db.from("memecoin_settings").insert({ user_id: userId }).select().maybeSingle();
    return DEFAULTS;
  }
  return { ...DEFAULTS, ...data } as MemeSettings;
}

async function loadWalletSecret(db: DB, userId: string): Promise<{ publicKey: string; secret: string } | null> {
  const { data } = await db.from("memecoin_wallets").select("public_key,encrypted_secret")
    .eq("user_id", userId).maybeSingle();
  if (!data?.encrypted_secret) return null;
  const secret = await decryptJSON<string>(data.encrypted_secret);
  return { publicKey: data.public_key as string, secret };
}

/** Refresh the scanned universe and persist the ranked candidates. */
export async function refreshSignals(db: DB): Promise<MemeCandidate[]> {
  const candidates = await scanMemecoins(20);
  const theses = await aiThesis(candidates);
  if (candidates.length) {
    await db.from("memecoin_signals").insert(candidates.map(c => ({
      mint: c.mint, symbol: c.symbol, name: c.name, score: c.score, verdict: c.verdict,
      price_usd: c.priceUsd, liquidity_usd: c.liquidityUsd, volume_24h_usd: c.volume24hUsd,
      fdv_usd: c.fdvUsd, age_minutes: Math.min(c.ageMinutes, 2147483647),
      change_5m: c.change5m, change_1h: c.change1h, buy_sell_ratio: c.buySellRatio,
      reasons: c.reasons, risk_flags: c.riskFlags, ai_thesis: theses[c.symbol] ?? null,
    })));
    // Keep the feed tight — only the recent window matters for a sniper.
    const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    await db.from("memecoin_signals").delete().lt("created_at", cutoff);
  }
  return candidates.map(c => ({ ...c, aiThesis: theses[c.symbol] } as MemeCandidate));
}

/** Open a snipe on one candidate. */
export async function buyCandidate(db: DB, userId: string, c: MemeCandidate, s: MemeSettings) {
  const wallet = await loadWalletSecret(db, userId);
  if (!wallet) throw new Error("No trading wallet key is configured — add one in the Wallet Vault");

  const balance = await solBalance(wallet.publicKey);
  if (balance < s.buy_amount_sol + 0.01) {
    throw new Error(`Wallet holds ${balance.toFixed(4)} SOL — need ${(s.buy_amount_sol + 0.01).toFixed(4)} including fees`);
  }

  const result = await swap({
    secret: wallet.secret, publicKey: wallet.publicKey, inputMint: SOL_MINT, outputMint: c.mint,
    amountRaw: Math.floor(s.buy_amount_sol * 1e9), slippageBps: s.slippage_bps,
  });

  const { data } = await db.from("memecoin_positions").insert({
    user_id: userId, mint: c.mint, symbol: c.symbol, status: "open",
    amount_sol: s.buy_amount_sol, tokens: result.outAmount,
    entry_price_usd: c.priceUsd, peak_price_usd: c.priceUsd,
    entry_tx: result.signature, score: c.score,
  }).select().maybeSingle();
  return { position: data, signature: result.signature, priceImpactPct: result.priceImpactPct };
}

/** Sell an open snipe back to SOL. */
export async function sellPosition(db: DB, userId: string, positionId: string, reason: string) {
  const { data: pos } = await db.from("memecoin_positions").select("*")
    .eq("id", positionId).eq("user_id", userId).maybeSingle();
  if (!pos || pos.status !== "open") throw new Error("Position is not open");

  const wallet = await loadWalletSecret(db, userId);
  if (!wallet) throw new Error("No trading wallet key is configured");

  const held = await tokenBalance(wallet.publicKey, pos.mint as string);
  if (held.amount <= 0) {
    await db.from("memecoin_positions").update({
      status: "closed", exit_reason: "no_tokens_held", closed_at: new Date().toISOString(),
    }).eq("id", positionId);
    return { closed: true, signature: null };
  }

  const settings = await loadSettings(db, userId);
  const result = await swap({
    secret: wallet.secret, publicKey: wallet.publicKey, inputMint: pos.mint as string, outputMint: SOL_MINT,
    amountRaw: held.amount, slippageBps: Math.max(settings.slippage_bps, 500),
  });

  const outSol = result.outAmount / 1e9;
  const pnlSol = outSol - Number(pos.amount_sol);
  const price = await priceForMint(pos.mint as string);

  await db.from("memecoin_positions").update({
    status: "closed", exit_tx: result.signature, exit_reason: reason,
    exit_price_usd: price, pnl_sol: pnlSol,
    pnl_pct: Number(pos.amount_sol) > 0 ? (pnlSol / Number(pos.amount_sol)) * 100 : 0,
    closed_at: new Date().toISOString(),
  }).eq("id", positionId);

  return { closed: true, signature: result.signature, pnlSol };
}

/** Trailing stop / take-profit / stop-loss enforcement on open snipes. */
export async function manageOpenPositions(db: DB, userId: string, s: MemeSettings) {
  const { data: open } = await db.from("memecoin_positions").select("*")
    .eq("user_id", userId).eq("status", "open");
  const actions: string[] = [];

  for (const pos of open ?? []) {
    const price = await priceForMint(pos.mint as string);
    if (!price) continue;
    const entry = Number(pos.entry_price_usd) || price;
    const peak = Math.max(Number(pos.peak_price_usd) || entry, price);
    const changePct = ((price - entry) / entry) * 100;
    const fromPeakPct = ((price - peak) / peak) * 100;

    await db.from("memecoin_positions").update({ peak_price_usd: peak }).eq("id", pos.id);

    let reason: string | null = null;
    if (changePct >= s.take_profit_pct) reason = `take_profit:+${changePct.toFixed(0)}%`;
    else if (changePct <= -s.stop_loss_pct) reason = `stop_loss:${changePct.toFixed(0)}%`;
    else if (changePct > 15 && fromPeakPct <= -s.trailing_stop_pct) reason = `trailing_stop:${fromPeakPct.toFixed(0)}% off peak`;

    if (reason) {
      try {
        await sellPosition(db, userId, pos.id as string, reason);
        actions.push(`${pos.symbol}:${reason}`);
      } catch (e) {
        actions.push(`${pos.symbol}:exit_failed:${e instanceof Error ? e.message : "error"}`);
      }
    }
  }
  return actions;
}

/** One full autonomous memecoin cycle for a user. */
export async function runMemecoinCycle(db: DB, userId: string) {
  const s = await loadSettings(db, userId);
  if (!s.enabled) return { skipped: "disabled", exits: [] as string[], entries: [] as string[] };

  const exits = await manageOpenPositions(db, userId, s);
  const entries: string[] = [];
  const notes: string[] = [];

  const candidates = await refreshSignals(db);
  if (!s.autotrade) return { skipped: "autotrade_off", exits, entries, scanned: candidates.length };

  // Daily loss circuit breaker.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: closedToday } = await db.from("memecoin_positions")
    .select("pnl_sol").eq("user_id", userId).eq("status", "closed").gte("closed_at", since);
  const realised = (closedToday ?? []).reduce((a: number, r: { pnl_sol: number | null }) => a + Number(r.pnl_sol ?? 0), 0);
  if (realised <= -Math.abs(s.max_daily_loss_sol)) {
    return { skipped: `daily_loss_cap:${realised.toFixed(3)}SOL`, exits, entries };
  }

  const { data: openNow } = await db.from("memecoin_positions").select("id,mint")
    .eq("user_id", userId).eq("status", "open");
  const openMints = new Set((openNow ?? []).map((p: { mint: string }) => p.mint));
  let slots = s.max_open_positions - (openNow?.length ?? 0);

  for (const c of candidates) {
    if (slots <= 0) break;
    if (openMints.has(c.mint)) continue;
    if (c.verdict !== "snipe") { notes.push(`${c.symbol}:verdict_${c.verdict}`); continue; }
    if (c.score < s.min_score) { notes.push(`${c.symbol}:score_${c.score}<${s.min_score}`); continue; }
    if (c.liquidityUsd < s.min_liquidity_usd) { notes.push(`${c.symbol}:liquidity`); continue; }
    try {
      const r = await buyCandidate(db, userId, c, s);
      entries.push(`${c.symbol}@${c.score}:${r.signature.slice(0, 10)}`);
      slots -= 1;
    } catch (e) {
      notes.push(`${c.symbol}:buy_failed:${e instanceof Error ? e.message : "error"}`);
    }
  }

  return { exits, entries, notes, scanned: candidates.length };
}
