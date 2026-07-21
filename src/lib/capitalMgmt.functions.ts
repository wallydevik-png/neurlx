import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const EntrySchema = z.object({
  entry_type: z.enum(["deposit", "withdrawal", "fee", "adjustment", "realized_pnl"]),
  amount_usd: z.number(),
  note: z.string().max(280).optional(),
  occurred_at: z.string().datetime().optional(),
});

const AllocSchema = z.object({
  allocations: z.array(
    z.object({
      bucket: z.string().min(1).max(60),
      target_pct: z.number().min(0).max(100),
      notes: z.string().max(200).optional(),
    })
  ),
});

const PolicySchema = z.object({
  cash_reserve_pct: z.number().min(0).max(100),
  compounding_mode: z.enum(["reinvest", "fixed", "withdraw_profits"]),
  fixed_base_usd: z.number().min(0),
  profit_withdraw_pct: z.number().min(0).max(100),
  scale_up_threshold_pct: z.number().min(0).max(500),
  scale_down_drawdown_pct: z.number().min(0).max(100),
});

export const addLedgerEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => EntrySchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("capital_ledger").insert({
      user_id: context.userId,
      entry_type: data.entry_type,
      amount_usd: data.amount_usd,
      note: data.note ?? null,
      occurred_at: data.occurred_at ?? new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteLedgerEntry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("capital_ledger").delete().eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setAllocations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AllocSchema.parse(d))
  .handler(async ({ data, context }) => {
    const total = data.allocations.reduce((s, a) => s + a.target_pct, 0);
    if (total > 100.01) throw new Error(`Allocations sum to ${total.toFixed(1)}% — must be ≤ 100%.`);
    await context.supabase.from("capital_allocations").delete().eq("user_id", context.userId);
    if (data.allocations.length) {
      const rows = data.allocations.map((a) => ({ ...a, user_id: context.userId }));
      const { error } = await context.supabase.from("capital_allocations").insert(rows);
      if (error) throw new Error(error.message);
    }
    return { ok: true, total };
  });

export const savePolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => PolicySchema.parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("capital_policy")
      .upsert({ user_id: context.userId, ...data }, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getCapitalOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const uid = context.userId;
    const [ledgerRes, allocRes, policyRes, snapRes] = await Promise.all([
      context.supabase.from("capital_ledger").select("*").eq("user_id", uid).order("occurred_at", { ascending: false }).limit(200),
      context.supabase.from("capital_allocations").select("*").eq("user_id", uid).order("bucket"),
      context.supabase.from("capital_policy").select("*").eq("user_id", uid).maybeSingle(),
      context.supabase.from("capital_snapshots").select("equity, snapshot_date").eq("user_id", uid).order("snapshot_date", { ascending: false }).limit(30),
    ]);
    if (ledgerRes.error) throw new Error(ledgerRes.error.message);

    const ledger = ledgerRes.data ?? [];
    let deposits = 0, withdrawals = 0, fees = 0, adjustments = 0, realized = 0;
    for (const r of ledger) {
      const a = Number(r.amount_usd);
      if (r.entry_type === "deposit") deposits += a;
      else if (r.entry_type === "withdrawal") withdrawals += a;
      else if (r.entry_type === "fee") fees += a;
      else if (r.entry_type === "adjustment") adjustments += a;
      else if (r.entry_type === "realized_pnl") realized += a;
    }
    const netContributed = deposits - withdrawals + adjustments;
    const totalPnl = realized - fees;

    const snaps = (snapRes.data ?? []).slice().reverse();
    const latestEquity = snaps.length ? Number(snaps[snaps.length - 1].equity) : netContributed + totalPnl;
    const firstEquity = snaps.length ? Number(snaps[0].equity) : latestEquity;
    const equityChangePct = firstEquity > 0 ? ((latestEquity - firstEquity) / firstEquity) * 100 : 0;

    const policy = policyRes.data ?? {
      cash_reserve_pct: 20,
      compounding_mode: "reinvest",
      fixed_base_usd: 0,
      profit_withdraw_pct: 0,
      scale_up_threshold_pct: 10,
      scale_down_drawdown_pct: 8,
    };

    // Deployable capital (based on compounding mode & cash reserve)
    let baseCapital = latestEquity;
    if (policy.compounding_mode === "fixed" && Number(policy.fixed_base_usd) > 0) {
      baseCapital = Math.min(latestEquity, Number(policy.fixed_base_usd));
    } else if (policy.compounding_mode === "withdraw_profits" && totalPnl > 0) {
      const withheld = totalPnl * (Number(policy.profit_withdraw_pct) / 100);
      baseCapital = Math.max(0, latestEquity - withheld);
    }
    const reserveUsd = baseCapital * (Number(policy.cash_reserve_pct) / 100);
    const deployableUsd = Math.max(0, baseCapital - reserveUsd);

    const allocations = (allocRes.data ?? []).map((a) => ({
      ...a,
      target_pct: Number(a.target_pct),
      target_usd: deployableUsd * (Number(a.target_pct) / 100),
    }));
    const allocatedPct = allocations.reduce((s, a) => s + Number(a.target_pct), 0);

    // Scale suggestion
    let scaleSuggestion: { action: "scale_up" | "scale_down" | "hold"; reason: string } = {
      action: "hold",
      reason: "Equity within normal band.",
    };
    if (equityChangePct >= Number(policy.scale_up_threshold_pct)) {
      scaleSuggestion = { action: "scale_up", reason: `Equity up ${equityChangePct.toFixed(1)}% — safe to compound risk.` };
    } else if (equityChangePct <= -Number(policy.scale_down_drawdown_pct)) {
      scaleSuggestion = { action: "scale_down", reason: `Drawdown ${equityChangePct.toFixed(1)}% — reduce risk per trade.` };
    }

    return {
      totals: { deposits, withdrawals, fees, adjustments, realized, netContributed, totalPnl, latestEquity, equityChangePct },
      policy,
      baseCapital,
      reserveUsd,
      deployableUsd,
      allocations,
      allocatedPct,
      ledger,
      scaleSuggestion,
    };
  });
