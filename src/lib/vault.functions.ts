import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Vault overview: address, live balances, ledger, on-chain activity, withdrawals. */
export const getVault = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { ensureVaultWallet, vaultBalances, recentChainActivity } =
      await import("@/lib/vault/wallet.server");

    const wallet = await ensureVaultWallet(userId);
    const [balances, chain, ledger, withdrawals, settings] = await Promise.all([
      vaultBalances(supabase, userId, wallet.publicKey),
      recentChainActivity(wallet.publicKey),
      supabase.from("vault_transactions").select("*")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(30),
      supabase.from("vault_withdrawals").select("id,asset,amount,destination,status,expires_at,signature,error,created_at")
        .eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
      supabase.from("automation_settings").select("kill_switch_active").eq("user_id", userId).maybeSingle(),
    ]);

    return {
      wallet: { address: wallet.publicKey, createdAt: wallet.createdAt },
      balances,
      chain,
      ledger: ledger.data ?? [],
      withdrawals: withdrawals.data ?? [],
      // The emergency stop halts new trades; it must never block a withdrawal.
      killSwitchActive: Boolean(settings.data?.kill_switch_active),
    };
  });

/**
 * Step 1 of a withdrawal: validate funds and destination, then issue a
 * one-time confirmation code delivered through the notification channel.
 * Nothing moves on-chain here.
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
    const { emitNotification } = await import("@/lib/notifications/emit.server");

    if (!isSolanaAddress(data.destination)) throw new Error("That is not a valid Solana address");
    const wallet = await getVaultWallet(userId);
    if (!wallet) throw new Error("No trading vault wallet yet — open the Vault page first");
    if (data.destination === wallet.address) throw new Error("Destination is your own vault address");

    const balances = await vaultBalances(supabase, userId, wallet.address);
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

    // Invalidate any earlier pending request so one code is live at a time.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("vault_withdrawals")
      .update({ status: "cancelled" }).eq("user_id", userId).eq("status", "pending_confirmation");

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    const expires = new Date(Date.now() + 10 * 60_000).toISOString();
    const { data: row, error } = await supabaseAdmin.from("vault_withdrawals").insert({
      user_id: userId, asset: data.asset, amount: data.amount, destination: data.destination,
      code_hash: await hashCode(userId, code), expires_at: expires,
    }).select("id").single();
    if (error) throw new Error(`Could not create the withdrawal request: ${error.message}`);

    await emitNotification(supabase, userId, {
      kind: "vault.withdrawal_code",
      severity: "critical",
      title: "Withdrawal confirmation code",
      message: `Code ${code} — confirms sending ${data.amount} ${data.asset} to ${data.destination.slice(0, 6)}…${data.destination.slice(-4)}. Expires in 10 minutes. If you did not request this, ignore it.`,
      payload: { withdrawal_id: row.id },
    });

    return { id: row.id as string, expiresAt: expires };
  });

/** Step 2: verify the code, then actually sign and broadcast the transfer. */
export const confirmWithdrawal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; code: string }) => ({
    id: String(d.id), code: String(d.code).trim(),
  }))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { vaultBalances, getVaultWallet, hashCode, withdrawSol, withdrawUsdc, recordVaultTx } =
      await import("@/lib/vault/wallet.server");
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
    const balances = await vaultBalances(supabase, userId, wallet.address);
    const amount = Number(req.amount);
    if (req.asset === "SOL" ? amount > balances.availableSol + 1e-9 : amount > balances.usdc + 1e-9) {
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "failed", error: "Insufficient available balance at send time" }).eq("id", req.id);
      throw new Error("Available balance changed — not enough funds to send this withdrawal now");
    }

    await supabaseAdmin.from("vault_withdrawals").update({ status: "sending" }).eq("id", req.id);
    try {
      const signature = req.asset === "SOL"
        ? await withdrawSol(userId, req.destination, amount)
        : await withdrawUsdc(userId, req.destination, amount);
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "sent", signature }).eq("id", req.id);
      await recordVaultTx(userId, {
        kind: "withdrawal", asset: req.asset, amount, signature,
        detail: { destination: req.destination },
      });
      await emitNotification(supabase, userId, {
        kind: "vault.withdrawal_sent", severity: "warning",
        title: "Withdrawal sent",
        message: `${amount} ${req.asset} sent to ${req.destination}.`,
        payload: { signature },
      });
      return { ok: true, signature };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabaseAdmin.from("vault_withdrawals")
        .update({ status: "failed", error: message }).eq("id", req.id);
      await recordVaultTx(userId, {
        kind: "withdrawal", asset: req.asset, amount, status: "failed",
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
