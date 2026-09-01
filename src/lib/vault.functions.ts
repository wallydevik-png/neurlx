import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Vault overview: address, live balances, ledger, on-chain activity, withdrawals. */
export const getVault = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { ensureVaultWallet, vaultBalances, recentChainActivity } =
      await import("@/lib/vault/wallet.server");
    const { loadPolicy, withdrawnLast24h } = await import("@/lib/vault/policy.server");
    const { emailTransportConfigured, accountEmail, maskEmail } = await import("@/lib/email/send.server");

    const wallet = await ensureVaultWallet(userId);
    const [balances, chain, ledger, withdrawals, settings, policy, usedSol, usedUsdc, destinations, email] =
      await Promise.all([
        vaultBalances(supabase, userId, wallet.publicKey),
        recentChainActivity(wallet.publicKey),
        supabase.from("vault_transactions").select("*")
          .eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
        // NOTE: code_hash and attempts are not selected here and are no longer
        // granted to the authenticated role — the confirmation secret must not
        // be reachable from a browser session.
        supabase.from("vault_withdrawals").select("id,asset,amount,destination,status,expires_at,signature,error,created_at")
          .eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
        supabase.from("automation_settings").select("kill_switch_active").eq("user_id", userId).maybeSingle(),
        loadPolicy(userId),
        withdrawnLast24h(userId, "SOL"),
        withdrawnLast24h(userId, "USDC"),
        supabase.from("vault_destinations").select("address,unlocks_at,first_seen_at")
          .eq("user_id", userId).order("first_seen_at", { ascending: false }).limit(25),
        accountEmail(userId),
      ]);

    return {
      wallet: { address: wallet.publicKey, createdAt: wallet.createdAt },
      balances,
      chain,
      ledger: ledger.data ?? [],
      withdrawals: withdrawals.data ?? [],
      policy: {
        ...policy,
        usedSol24h: usedSol,
        usedUsdc24h: usedUsdc,
        remainingSol24h: Math.max(0, policy.dailyLimitSol - usedSol),
        remainingUsdc24h: Math.max(0, policy.dailyLimitUsdc - usedUsdc),
      },
      destinations: destinations.data ?? [],
      confirmation: {
        channel: "email" as const,
        configured: emailTransportConfigured() && Boolean(email),
        sendTo: email ? maskEmail(email) : null,
      },
      // The emergency stop halts new trades; it must never block a withdrawal.
      killSwitchActive: Boolean(settings.data?.kill_switch_active),
    };
  });

/**
 * Step 1 of a withdrawal: validate funds, daily limit and destination
 * cooldown, then issue a one-time confirmation code delivered BY EMAIL —
 * deliberately out-of-band, so holding the app session is not enough to
 * complete a withdrawal. Nothing moves on-chain here.
 */
export const requestWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { asset: "SOL" | "USDC"; amount: number; destination: string }) => {
    if (d.asset !== "SOL" && d.asset !== "USDC") throw new Error("Unsupported asset");
    if (!Number.isFinite(d.amount) || d.amount <= 0) throw new Error("Enter an amount greater than zero");
    return { asset: d.asset, amount: Number(d.amount), destination: String(d.destination).trim() };
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { getVaultWallet, vaultBalances, isSolanaAddress, hashCode } =
      await import("@/lib/vault/wallet.server");
    const { loadPolicy, withdrawnLast24h, noteDestination, destinationUnlocked, humanDelay } =
      await import("@/lib/vault/policy.server");
    const { sendEmail, accountEmail, maskEmail } = await import("@/lib/email/send.server");
    const { emitNotification } = await import("@/lib/notifications/emit.server");

    if (!isSolanaAddress(data.destination)) throw new Error("That is not a valid Solana address");
    const wallet = await getVaultWallet(userId);
    if (!wallet) throw new Error("No trading vault wallet yet — open the Vault page first");
    if (data.destination === wallet.publicKey) throw new Error("Destination is your own vault address");

    const balances = await vaultBalances(supabase, userId, wallet.publicKey);
    if (data.asset === "SOL") {
      if (data.amount > balances.availableSol + 1e-9) {
        throw new Error(
          `Only ${balances.availableSol.toFixed(4)} SOL is available ` +
          `(${balances.reservedSol.toFixed(4)} is reserved by open positions, plus a small fee reserve).`,
        );
      }
    } else if (data.amount > balances.usdc + 1e-9) {
      throw new Error(`Only ${balances.usdc.toFixed(2)} USDC is available`);
    }

    // --- Withdrawal protection: daily cap ---
    const policy = await loadPolicy(userId);
    const limit = data.asset === "SOL" ? policy.dailyLimitSol : policy.dailyLimitUsdc;
    const used = await withdrawnLast24h(userId, data.asset);
    if (used + data.amount > limit + 1e-9) {
      throw new Error(
        `Daily withdrawal limit reached: ${used.toFixed(4)} of ${limit} ${data.asset} used in the last 24 hours. ` +
        `You can withdraw up to ${Math.max(0, limit - used).toFixed(4)} ${data.asset} right now.`,
      );
    }

    // --- Withdrawal protection: first-use cooldown on a new address ---
    const dest = await noteDestination(userId, data.destination, policy.cooldownMinutes);
    if (!destinationUnlocked(dest.unlocksAt)) {
      throw new Error(
        `This is a new destination address. For your protection it unlocks in ${humanDelay(dest.unlocksAt)} ` +
        `(${new Date(dest.unlocksAt).toISOString()}). Existing addresses are unaffected.`,
      );
    }

    // --- Out-of-band delivery target, resolved BEFORE anything is written ---
    const email = await accountEmail(userId);
    if (!email) throw new Error("No email address on this account — add one before withdrawing");

    // Invalidate any earlier pending request so one code is live at a time.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("vault_withdrawals")
      .update({ status: "cancelled" }).eq("user_id", userId).eq("status", "pending_confirmation");

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const { data: row, error } = await supabaseAdmin.from("vault_withdrawals").insert({
      user_id: userId, asset: data.asset, amount: data.amount, destination: data.destination,
      code_hash: await hashCode(userId, code), expires_at: expires,
      code_channel: "email", code_sent_to: maskEmail(email),
    }).select("id").single();
    if (error) throw new Error(`Could not create the withdrawal request: ${error.message}`);

    const short = `${data.destination.slice(0, 6)}…${data.destination.slice(-4)}`;
    try {
      await sendEmail({
        to: email,
        subject: `NeurlX withdrawal code ${code}`,
        text:
          `Your NeurlX Trading Vault confirmation code is ${code}.\n\n` +
          `It confirms sending ${data.amount} ${data.asset} to ${data.destination}.\n` +
          `The code expires in 10 minutes and can be used once.\n\n` +
          `If you did not request this withdrawal, do not enter the code — sign out of ` +
          `every session and change your password immediately.`,
      });
    } catch (e) {
      // No out-of-band delivery means no withdrawal. Fail closed rather than
      // falling back to the in-app channel the session can already read.
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "cancelled", error: "code delivery failed" }).eq("id", row.id);
      throw new Error(
        `Could not send the confirmation code by email, so the withdrawal was cancelled. ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // The in-app notice deliberately contains NO code — only the fact that a
    // withdrawal was requested, so an attacker's activity is visible to you.
    await emitNotification(supabase, userId, {
      kind: "vault.withdrawal_requested",
      severity: "critical",
      title: "Withdrawal requested",
      message: `A confirmation code was emailed to ${maskEmail(email)} for ${data.amount} ${data.asset} to ${short}. If this was not you, cancel it now.`,
      payload: { withdrawal_id: row.id },
    });

    return { id: row.id as string, expiresAt: expires, sentTo: maskEmail(email) };
  });

/** Step 2: verify the emailed code, then actually sign and broadcast the transfer. */
export const confirmWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; code: string }) => ({
    id: String(d.id), code: String(d.code).trim(),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { vaultBalances, getVaultWallet, hashCode, withdrawSol, withdrawUsdc, recordVaultTx } =
      await import("@/lib/vault/wallet.server");
    const { loadPolicy, withdrawnLast24h } = await import("@/lib/vault/policy.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { emitNotification } = await import("@/lib/notifications/emit.server");

    const { data: req } = await supabaseAdmin.from("vault_withdrawals")
      .select("*").eq("id", data.id).eq("user_id", userId).maybeSingle();
    if (!req) throw new Error("Withdrawal request not found");
    if (req.status !== "pending_confirmation") throw new Error(`This request is already ${req.status}`);
    if (new Date(req.expires_at).getTime() < Date.now()) {
      await supabaseAdmin.from("vault_withdrawals").update({ status: "expired" }).eq("id", req.id);
      throw new Error("The confirmation code expired — start the withdrawal again");
    }
    if (Number(req.attempts) >= 5) {
      await supabaseAdmin.from("vault_withdrawals").update({ status: "cancelled" }).eq("id", req.id);
      throw new Error("Too many incorrect codes — the request was cancelled");
    }
    if (await hashCode(userId, data.code) !== req.code_hash) {
      await supabaseAdmin.from("vault_withdrawals")
        .update({ attempts: Number(req.attempts) + 1 }).eq("id", req.id);
      throw new Error("Incorrect confirmation code");
    }

    // Re-check funds at send time: a trade may have consumed balance while the
    // code was outstanding.
    const wallet = await getVaultWallet(userId);
    if (!wallet) throw new Error("No trading vault wallet");
    const balances = await vaultBalances(supabase, userId, wallet.publicKey);
    const amount = Number(req.amount);
    const asset = req.asset as "SOL" | "USDC";
    if (asset === "SOL" ? amount > balances.availableSol + 1e-9 : amount > balances.usdc + 1e-9) {
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "failed", error: "Insufficient available balance at send time" }).eq("id", req.id);
      throw new Error("Available balance changed — not enough funds to send this withdrawal now");
    }

    // Re-check the daily cap at send time too, so two requests created before
    // either was confirmed cannot together exceed the limit.
    const policy = await loadPolicy(userId);
    const limit = asset === "SOL" ? policy.dailyLimitSol : policy.dailyLimitUsdc;
    const used = await withdrawnLast24h(userId, asset);
    if (used + amount > limit + 1e-9) {
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "failed", error: "Daily withdrawal limit reached" }).eq("id", req.id);
      throw new Error(`Daily withdrawal limit reached (${used.toFixed(4)} of ${limit} ${asset} in 24h)`);
    }

    // ---- Atomic claim -------------------------------------------------
    // The status transition is the lock. Only the request that flips
    // pending_confirmation -> sending may sign; a concurrent confirmation
    // matches zero rows here and stops before touching the keypair.
    const { data: claimed } = await supabaseAdmin.from("vault_withdrawals")
      .update({ status: "sending", confirmed_at: new Date().toISOString() })
      .eq("id", req.id).eq("user_id", userId).eq("status", "pending_confirmation")
      .select("id");
    if (!claimed || claimed.length !== 1) {
      throw new Error("This withdrawal is already being processed");
    }

    try {
      const signature = asset === "SOL"
        ? await withdrawSol(userId, req.destination, amount)
        : await withdrawUsdc(userId, req.destination, amount);
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "sent", signature }).eq("id", req.id);
      await recordVaultTx(userId, {
        kind: "withdrawal", asset, amount, signature,
        detail: { destination: req.destination },
      });
      await emitNotification(supabase, userId, {
        kind: "vault.withdrawal_sent", severity: "warning",
        title: "Withdrawal sent",
        message: `${amount} ${asset} sent to ${req.destination}.`,
        payload: { signature },
      });
      return { ok: true, signature };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "failed", error: message }).eq("id", req.id);
      await recordVaultTx(userId, {
        kind: "withdrawal", asset, amount, status: "failed",
        detail: { destination: req.destination, error: message },
      });
      throw new Error(`Withdrawal failed: ${message}`);
    }
  });

export const cancelWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => ({ id: String(d.id) }))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("vault_withdrawals").update({ status: "cancelled" })
      .eq("id", data.id).eq("user_id", context.userId).eq("status", "pending_confirmation");
    return { ok: true };
  });

/**
 * Update withdrawal protection. Tightening applies immediately; loosening is
 * staged for 24 hours so a stolen session cannot raise the cap and drain the
 * vault in one sitting.
 */
export const updateWithdrawalPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { dailyLimitSol: number; dailyLimitUsdc: number; cooldownMinutes: number }) => {
    const num = (v: number, min: number, max: number, label: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}`);
      return n;
    };
    return {
      dailyLimitSol: num(d.dailyLimitSol, 0, 10_000, "Daily SOL limit"),
      dailyLimitUsdc: num(d.dailyLimitUsdc, 0, 1_000_000, "Daily USDC limit"),
      cooldownMinutes: num(d.cooldownMinutes, 0, 20_160, "New-address cooldown"),
    };
  })
  .handler(async ({ data, context }) => {
    const { userId, supabase } = context;
    const { loadPolicy, splitPolicyChange, LOOSEN_DELAY_MS } = await import("@/lib/vault/policy.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { emitNotification } = await import("@/lib/notifications/emit.server");

    const current = await loadPolicy(userId);
    const { immediate, staged } = splitPolicyChange(current, data);
    const effectiveAt = staged ? new Date(Date.now() + LOOSEN_DELAY_MS).toISOString() : null;

    await supabaseAdmin.from("vault_withdrawal_policy").upsert({
      user_id: userId,
      daily_limit_sol: immediate.dailyLimitSol,
      daily_limit_usdc: immediate.dailyLimitUsdc,
      new_address_cooldown_minutes: immediate.cooldownMinutes,
      pending_daily_limit_sol: staged?.dailyLimitSol ?? null,
      pending_daily_limit_usdc: staged?.dailyLimitUsdc ?? null,
      pending_cooldown_minutes: staged?.cooldownMinutes ?? null,
      pending_effective_at: effectiveAt,
    }, { onConflict: "user_id" });

    await emitNotification(supabase, userId, {
      kind: "vault.policy_changed", severity: "critical",
      title: "Withdrawal protection changed",
      message: staged
        ? `Tighter limits applied now. The looser settings take effect ${new Date(effectiveAt!).toISOString()}.`
        : "Withdrawal protection was tightened.",
    });

    return { applied: immediate, pendingUntil: effectiveAt };
  });
