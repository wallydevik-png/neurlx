import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Desk data: settings, wallet summary, live signals, open + closed snipes. */
export const getMemecoinDesk = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { loadSettings } = await import("@/lib/memecoin/engine.server");
    const settings = await loadSettings(supabase, userId);

    // The wallet row is deliberately unreadable under RLS (it holds the
    // encrypted secret), so read it server-side and return only safe fields.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: wallet }, { data: signals }, { data: positions }, { data: roles }] = await Promise.all([
      supabaseAdmin.from("memecoin_wallets").select("public_key,phantom_address,label,encrypted_secret,updated_at")
        .eq("user_id", userId).maybeSingle(),
      supabase.from("memecoin_signals").select("*").order("created_at", { ascending: false }).limit(60),
      supabase.from("memecoin_positions").select("*").eq("user_id", userId)
        .order("opened_at", { ascending: false }).limit(50),
      supabase.from("user_roles").select("role").eq("user_id", userId),
    ]);

    // De-duplicate the feed to the newest row per mint.
    const seen = new Set<string>();
    const latestSignals = (signals ?? []).filter(s => {
      if (seen.has(s.mint)) return false;
      seen.add(s.mint);
      return true;
    }).slice(0, 15);

    let walletSol: number | null = null;
    if (wallet?.public_key) {
      try {
        const { solBalance } = await import("@/lib/memecoin/jupiter.server");
        walletSol = await solBalance(wallet.public_key);
      } catch { walletSol = null; }
    }

    const open = (positions ?? []).filter(p => p.status === "open");
    const closed = (positions ?? []).filter(p => p.status === "closed");
    const realisedSol = closed.reduce((a, p) => a + Number(p.pnl_sol ?? 0), 0);
    const wins = closed.filter(p => Number(p.pnl_sol ?? 0) > 0).length;

    return {
      settings,
      wallet: wallet ? {
        public_key: wallet.public_key,
        phantom_address: wallet.phantom_address,
        label: wallet.label,
        updated_at: wallet.updated_at,
        hasKey: Boolean(wallet.encrypted_secret),
        sol: walletSol,
      } : null,
      signals: latestSignals,
      open, closed,
      stats: {
        realisedSol: +realisedSol.toFixed(4),
        winRate: closed.length ? Math.round((wins / closed.length) * 100) : 0,
        trades: closed.length,
      },
      isAdmin: (roles ?? []).some(r => r.role === "admin"),
    };
  });

/** Update sniper controls. */
export const updateMemecoinSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: Record<string, number | boolean>) => d)
  .handler(async ({ data, context }) => {
    const numeric = [
      "buy_amount_sol", "max_open_positions", "take_profit_pct", "stop_loss_pct",
      "trailing_stop_pct", "min_liquidity_usd", "min_score", "slippage_bps", "max_daily_loss_sol",
    ];
    const patch: Record<string, number | boolean> = {};
    for (const [k, v] of Object.entries(data)) {
      if (k === "enabled" || k === "autotrade") patch[k] = Boolean(v);
      else if (numeric.includes(k)) patch[k] = Number(v);
    }
    await context.supabase.from("memecoin_settings")
      .upsert({ user_id: context.userId, ...patch }, { onConflict: "user_id" });
    return { ok: true };
  });

/** Store the Phantom address the user connected in the browser. */
export const linkPhantomWallet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { address: string }) => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.address)) throw new Error("That is not a valid Solana address");
    return d;
  })
  .handler(async ({ data, context }) => {
    const { data: existing } = await context.supabase.from("memecoin_wallets")
      .select("user_id").eq("user_id", context.userId).maybeSingle();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (existing) {
      await supabaseAdmin.from("memecoin_wallets")
        .update({ phantom_address: data.address }).eq("user_id", context.userId);
    } else {
      await supabaseAdmin.from("memecoin_wallets").insert({
        user_id: context.userId, public_key: data.address, phantom_address: data.address,
        label: "Phantom (watch only)",
      });
    }
    return { ok: true };
  });

/** Import the authenticated user's Solana wallet, encrypted at rest. */
export const saveTradingWalletKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { secretKey: string; label?: string }) => {
    if (!d || typeof d.secretKey !== "string") throw new Error("Wallet secret is required");
    const secretKey = d.secretKey.trim();
    if (secretKey.length < 32 || secretKey.length > 500) throw new Error("Wallet secret has an invalid length");
    return { secretKey, label: typeof d.label === "string" ? d.label.trim().slice(0, 80) : undefined };
  })
  .handler(async ({ data, context }) => {
    const { resolveFundedKeypair } = await import("@/lib/memecoin/jupiter.server");
    let publicKey: string;
    let sol = 0;
    try {
      const resolved = await resolveFundedKeypair(data.secretKey);
      publicKey = resolved.keypair.publicKey.toBase58();
      sol = resolved.sol;
    } catch {
      throw new Error("That wallet could not be read. Enter a valid Phantom recovery phrase or private key.");
    }

    const { encryptJSON } = await import("@/lib/crypto.server");
    const encrypted = await encryptJSON(data.secretKey.trim());
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("memecoin_wallets").upsert({
      user_id: context.userId, public_key: publicKey, encrypted_secret: encrypted,
      phantom_address: publicKey,
      label: data.label || "Imported sniper wallet",
    }, { onConflict: "user_id" });

    return { ok: true, publicKey, sol };
  });

/** Admin-only: forget the stored key (trading stops immediately). */
export const removeTradingWalletKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase
      .rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) throw new Error("Only an admin can change the wallet vault");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("memecoin_wallets")
      .update({ encrypted_secret: null }).eq("user_id", context.userId);
    await supabaseAdmin.from("memecoin_settings")
      .update({ autotrade: false }).eq("user_id", context.userId);
    return { ok: true };
  });

/** Admin-only vault view. */
export const getWalletVault = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase
      .rpc("has_role", { _user_id: context.userId, _role: "admin" });
    if (!isAdmin) return { isAdmin: false as const, wallet: null, sol: null };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: wallet } = await supabaseAdmin.from("memecoin_wallets")
      .select("public_key,phantom_address,label,encrypted_secret,updated_at")
      .eq("user_id", context.userId).maybeSingle();

    let sol: number | null = null;
    if (wallet?.public_key) {
      try {
        const { solBalance } = await import("@/lib/memecoin/jupiter.server");
        sol = await solBalance(wallet.public_key);
      } catch { sol = null; }
    }
    return {
      isAdmin: true as const,
      wallet: wallet ? {
        public_key: wallet.public_key, phantom_address: wallet.phantom_address,
        label: wallet.label, hasKey: Boolean(wallet.encrypted_secret), updated_at: wallet.updated_at,
      } : null,
      sol,
    };
  });

/** Manual market refresh. */
export const scanMemecoinsNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { refreshSignals } = await import("@/lib/memecoin/engine.server");
    const found = await refreshSignals(context.supabase);
    return { scanned: found.length };
  });

/** Manual snipe on a scanned candidate. */
export const snipeSignal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { signalId: string }) => d)
  .handler(async ({ data, context }) => {
    const { data: sig } = await context.supabase.from("memecoin_signals")
      .select("*").eq("id", data.signalId).maybeSingle();
    if (!sig) throw new Error("That signal is no longer available");

    const { loadSettings, buyCandidate } = await import("@/lib/memecoin/engine.server");
    const settings = await loadSettings(context.supabase, context.userId);
    const r = await buyCandidate(context.supabase, context.userId, {
      mint: sig.mint, symbol: sig.symbol, name: sig.name ?? sig.symbol,
      priceUsd: Number(sig.price_usd ?? 0), liquidityUsd: Number(sig.liquidity_usd ?? 0),
      volume24hUsd: Number(sig.volume_24h_usd ?? 0), volume5mUsd: 0,
      fdvUsd: Number(sig.fdv_usd ?? 0), ageMinutes: Number(sig.age_minutes ?? 0),
      change5m: Number(sig.change_5m ?? 0), change1h: Number(sig.change_1h ?? 0), change6h: 0,
      buySellRatio: Number(sig.buy_sell_ratio ?? 1), txns24h: 0,
      score: Number(sig.score ?? 0), verdict: "snipe", reasons: [], riskFlags: [], url: "",
    }, settings);
    return { signature: r.signature };
  });

/** Manual exit. */
export const exitMemecoinPosition = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { positionId: string }) => d)
  .handler(async ({ data, context }) => {
    const { sellPosition } = await import("@/lib/memecoin/engine.server");
    return sellPosition(context.supabase, context.userId, data.positionId, "manual_exit");
  });

/** Run one full sniper cycle now. */
export const runMemecoinCycleNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { runMemecoinCycle } = await import("@/lib/memecoin/engine.server");
    return runMemecoinCycle(context.supabase, context.userId);
  });
