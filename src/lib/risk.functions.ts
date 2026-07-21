// Advanced Risk server functions: dashboard, sizing, settings, snapshots.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = <T,>(v: T) => v as any;

async function loadOrCreateSettings(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any, userId: string,
) {
  const { data } = await supabase
    .from("advanced_risk_settings").select("*").eq("user_id", userId).maybeSingle();
  if (data) return data;
  const { data: created } = await supabase
    .from("advanced_risk_settings").insert({ user_id: userId }).select("*").maybeSingle();
  return created;
}

export const getAdvancedRiskSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const s = await loadOrCreateSettings(context.supabase, context.userId);
    return asJson(s);
  });

const SettingsSchema = z.object({
  max_portfolio_heat_pct: z.number().min(0.5).max(50),
  max_correlation: z.number().min(0).max(1),
  max_var_pct: z.number().min(0.5).max(50),
  target_daily_vol_pct: z.number().min(0.1).max(20),
  kelly_fraction: z.number().min(0).max(1),
  max_sector_pct: z.number().min(5).max(100),
});

export const saveAdvancedRiskSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => SettingsSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await loadOrCreateSettings(supabase, userId);
    const { error } = await supabase.from("advanced_risk_settings")
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getRiskDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const [acctR, posR, settingsR, snapR] = await Promise.all([
      supabase.from("paper_accounts").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("positions").select("*").eq("user_id", userId).eq("status", "open"),
      supabase.from("advanced_risk_settings").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("risk_snapshots").select("*").eq("user_id", userId)
        .order("captured_at", { ascending: false }).limit(30),
    ]);
    const settings = settingsR.data ?? await loadOrCreateSettings(supabase, userId);
    const equity = Number(acctR.data?.equity ?? acctR.data?.cash_balance ?? 10000);
    const holdings = (posR.data ?? []).map((p: Record<string, unknown>) => ({
      symbol: String(p.symbol),
      qty: Number(p.qty),
      avgEntry: Number(p.avg_entry),
      stopLoss: p.stop_loss != null ? Number(p.stop_loss) : null,
      side: (p.side as "long" | "short") ?? "long",
    }));

    const { computePortfolioRisk } = await import("@/lib/risk/portfolioRisk.server");
    const report = await computePortfolioRisk(supabase, { equity, holdings });

    // Persist snapshot for the equity curve of risk history.
    await supabase.from("risk_snapshots").insert({
      user_id: userId,
      equity,
      portfolio_heat_pct: report.portfolioHeatPct,
      var_95_pct: report.var95Pct,
      cvar_95_pct: report.cvar95Pct,
      portfolio_vol_pct: report.portfolioVolPct,
      max_correlation: report.correlationMax,
      open_positions: report.openPositions,
      risk_score: report.riskScore,
    });

    // Breach checks against user settings.
    const breaches: string[] = [];
    if (report.portfolioHeatPct > Number(settings.max_portfolio_heat_pct))
      breaches.push(`Portfolio heat ${report.portfolioHeatPct.toFixed(1)}% > cap ${settings.max_portfolio_heat_pct}%`);
    if (report.var95Pct > Number(settings.max_var_pct))
      breaches.push(`VaR95 ${report.var95Pct.toFixed(1)}% > cap ${settings.max_var_pct}%`);
    if (Math.abs(report.correlationMax) > Number(settings.max_correlation))
      breaches.push(`Correlation |${report.correlationMax.toFixed(2)}| > cap ${settings.max_correlation}`);

    return asJson({ settings, report, breaches, history: snapR.data ?? [] });
  });

const SizeSchema = z.object({
  symbol: z.string().min(1),
  entry: z.number().positive(),
  stopLoss: z.number().positive(),
  confidence: z.number().min(0).max(1),
});

export const suggestPositionSize = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => SizeSchema.parse(raw))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [acctR, settingsR] = await Promise.all([
      supabase.from("paper_accounts").select("equity,cash_balance").eq("user_id", userId).maybeSingle(),
      supabase.from("advanced_risk_settings").select("*").eq("user_id", userId).maybeSingle(),
    ]);
    const settings = settingsR.data ?? await loadOrCreateSettings(supabase, userId);
    const equity = Number(acctR.data?.equity ?? acctR.data?.cash_balance ?? 10000);
    const { sizePosition } = await import("@/lib/risk/portfolioRisk.server");
    const result = await sizePosition(supabase, {
      equity,
      symbol: data.symbol,
      entry: data.entry,
      stopLoss: data.stopLoss,
      confidence: data.confidence,
      targetDailyVolPct: Number(settings.target_daily_vol_pct),
      kellyFraction: Number(settings.kelly_fraction),
    });
    return asJson({ equity, result });
  });
