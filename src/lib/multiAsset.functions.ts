import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const ASSET_CLASSES = [
  { id: "crypto_spot", label: "Crypto Spot" },
  { id: "crypto_perp", label: "Crypto Perpetuals" },
  { id: "equity", label: "Equities" },
  { id: "forex", label: "Forex" },
  { id: "commodity", label: "Commodities" },
  { id: "index", label: "Indices" },
] as const;

export const getMultiAssetOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [uniRes, watchRes] = await Promise.all([
      context.supabase.from("asset_universe").select("*").eq("is_active", true).order("asset_class").order("symbol"),
      context.supabase.from("user_watchlists").select("*").eq("user_id", context.userId),
    ]);
    if (uniRes.error) throw new Error(uniRes.error.message);
    if (watchRes.error) throw new Error(watchRes.error.message);

    const universe = uniRes.data ?? [];
    const watchIds = new Set((watchRes.data ?? []).filter((w) => w.enabled).map((w) => w.instrument_id));

    const byClass: Record<string, any[]> = {};
    for (const inst of universe) {
      (byClass[inst.asset_class] ??= []).push({ ...inst, watched: watchIds.has(inst.id) });
    }

    const stats = ASSET_CLASSES.map((c) => ({
      id: c.id,
      label: c.label,
      total: (byClass[c.id] ?? []).length,
      watched: (byClass[c.id] ?? []).filter((i) => i.watched).length,
    }));

    return { byClass, stats, totalWatched: watchIds.size, totalUniverse: universe.length };
  });

export const toggleWatchlist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ instrument_id: z.string().uuid(), enabled: z.boolean() }).parse(d)
  )
  .handler(async ({ data, context }) => {
    if (data.enabled) {
      const { error } = await context.supabase
        .from("user_watchlists")
        .upsert(
          { user_id: context.userId, instrument_id: data.instrument_id, enabled: true },
          { onConflict: "user_id,instrument_id" }
        );
      if (error) throw new Error(error.message);
    } else {
      const { error } = await context.supabase
        .from("user_watchlists")
        .delete()
        .eq("user_id", context.userId)
        .eq("instrument_id", data.instrument_id);
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });
