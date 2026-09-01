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

async function loadWalletSecret(_db: DB, userId: string): Promise<{ publicKey: string; secret: string } | null> {
  // RLS on memecoin_wallets only grants SELECT to admins reading their own
  // row ("admins read own wallet row" policy) — the table is deliberately
  // unreadable by ordinary authenticated users because it holds the
  // encrypted secret. Every entrypoint here (manual snipe, manual exit,
  // "run cycle now", and the position manager) is invoked with the
  // request-scoped, RLS-bound client for non-admin users, so passing that
  // client straight into this SELECT silently returned zero rows for every
  // non-admin trader — buyCandidate/sellPosition then failed with "No
  // trading wallet key is configured" even though a wallet was saved, which
  // is why entries/exits never fired outside the cron path (which happens
  // to run as the service role). Always read this one table through the
  // service-role client, exactly like getMemecoinDesk already does.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("memecoin_wallets").select("public_key,encrypted_secret")
    .eq("user_id", userId).maybeSingle();
  if (data?.encrypted_secret) {
    const secret = await decryptJSON<string>(data.encrypted_secret);
    return { publicKey: data.public_key as string, secret };
  }

  // No imported wallet — fall back to this user's NeurlX Trading Vault, the
  // custodial wallet they deposit into. Strictly scoped by user_id, so the
  // engine can only ever spend the balance belonging to this user.
  const { data: vault } = await supabaseAdmin.from("vault_wallets")
    .select("public_key,encrypted_secret").eq("user_id", userId).maybeSingle();
  if (!vault?.encrypted_secret) return null;
  const payload = await decryptJSON<{ secret: string }>(vault.encrypted_secret);
  return { publicKey: vault.public_key as string, secret: payload.secret };
}

export type ScanTelemetry = {
  universe: number; scored: number;
  verdicts: { snipe: number; watch: number; avoid: number };
  /** True when the live scan came back empty (provider rate-limit/outage) and
   *  the recently persisted feed was reused instead. */
  stale?: boolean;
};

/** Refresh the scanned universe and persist the ranked candidates. */
export async function refreshSignals(db: DB): Promise<{ candidates: MemeCandidate[]; scan: ScanTelemetry }> {
  const { scanMemecoinsDetailed } = await import("./scanner.server");
  const res = await scanMemecoinsDetailed(20);
  if (!res.candidates.length) {
    // A rate-limited provider must not look like an empty market. Reuse the
    // recent persisted feed so exits/entries can still be evaluated, and say
    // so through telemetry.
    const since = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const { data } = await db.from("memecoin_signals").select("*")
      .gte("created_at", since).order("score", { ascending: false }).limit(20);
    const cached: MemeCandidate[] = (data ?? []).map((r: Record<string, unknown>) => ({
      mint: r.mint as string, symbol: r.symbol as string, name: (r.name as string) ?? "",
      score: Number(r.score), verdict: r.verdict as MemeCandidate["verdict"],
      priceUsd: Number(r.price_usd), liquidityUsd: Number(r.liquidity_usd),
      volume24hUsd: Number(r.volume_24h_usd), fdvUsd: Number(r.fdv_usd),
      ageMinutes: Number(r.age_minutes), change5m: Number(r.change_5m),
      change1h: Number(r.change_1h), buySellRatio: Number(r.buy_sell_ratio),
      reasons: (r.reasons as string[]) ?? [], riskFlags: (r.risk_flags as string[]) ?? [],
      aiThesis: (r.ai_thesis as string) ?? undefined,
      volume5mUsd: 0, change6h: 0, txns24h: 0, url: "",
    } as MemeCandidate));
    const verdicts = { snipe: 0, watch: 0, avoid: 0 };
    for (const c of cached) verdicts[c.verdict]++;
    return { candidates: cached, scan: { universe: cached.length, scored: cached.length, verdicts, stale: true } };
  }
  const candidates = res.candidates;
  const theses = await aiThesis(candidates);

  if (candidates.length) {
    // Replace-per-mint rather than blind insert: the old code appended a new
    // row on every scan, so the same token accumulated dozens of duplicate
    // rows within the 6h window and the feed looked frozen.
    const mints = candidates.map(c => c.mint);
    await db.from("memecoin_signals").delete().in("mint", mints);
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
  return {
    candidates: candidates.map(c => ({ ...c, aiThesis: theses[c.symbol] } as MemeCandidate)),
    scan: { universe: res.universe, scored: res.scored, verdicts: res.verdicts },
  };
}

/** Open a snipe on one candidate. */
export async function buyCandidate(db: DB, userId: string, c: MemeCandidate, s: MemeSettings) {
  const wallet = await loadWalletSecret(db, userId);
  if (!wallet) throw new Error("No trading wallet key is configured — add one in the Wallet Vault");

  // Spend against AVAILABLE balance, not the raw on-chain figure: the raw
  // number still contains SOL already committed to open positions and the fee
  // reserve, so two concurrent snipes could both see the same unreserved SOL
  // and double-spend it.
  const { vaultBalances } = await import("@/lib/vault/wallet.server");
  const balances = await vaultBalances(db as unknown as SupabaseClient, userId, wallet.publicKey);
  if (balances.error) throw new Error(`Balance unavailable: ${balances.error}`);
  const needed = s.buy_amount_sol + 0.01;
  if (balances.availableSol < needed) {
    throw new Error(
      `Only ${balances.availableSol.toFixed(4)} SOL is available — need ${needed.toFixed(4)} including fees ` +
      `(${balances.sol.toFixed(4)} on-chain, ${balances.reservedSol.toFixed(4)} reserved by open positions)`,
    );
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
  if (!s.enabled) return { skipped: "disabled", exits: [] as string[], entries: [] as string[], scan: null };

  const exits = await manageOpenPositions(db, userId, s);
  const entries: string[] = [];
  const notes: string[] = [];

  const refreshed = await refreshSignals(db);
  const candidates = refreshed.candidates;
  // Scan telemetry is returned on every path — the user needs to SEE that the
  // scanner looked at 180 tokens and 2 were snipeable rather than assume the
  // sniper is dead.
  const scan = refreshed.scan;
  if (!s.autotrade) {
    return { skipped: "autotrade_off", exits, entries, notes, scan, scanned: candidates.length };
  }

  // Daily loss circuit breaker.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: closedToday } = await db.from("memecoin_positions")
    .select("pnl_sol").eq("user_id", userId).eq("status", "closed").gte("closed_at", since);
  const realised = (closedToday ?? []).reduce((a: number, r: { pnl_sol: number | null }) => a + Number(r.pnl_sol ?? 0), 0);
  if (realised <= -Math.abs(s.max_daily_loss_sol)) {
    return { skipped: `daily_loss_cap:${realised.toFixed(3)}SOL`, exits, entries, notes, scan };
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

  return { exits, entries, notes, scan, scanned: candidates.length };
}
