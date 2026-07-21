// Alternative Data server functions — read-through with no DB persistence
// (providers are deterministic per 5-min bucket; caching would be redundant).
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { AltComposite } from "./altdata/types";
import { listSupportedSymbols } from "./marketdata/symbols";

const SymbolIn = z.object({ symbol: z.string().min(1).max(32) });

export interface AltSignalOut {
  kind: string;
  provider: string;
  score: number;
  confidence: number;
  payload: Record<string, any>;
}
export interface AltDataResult {
  symbol: string;
  signals: AltSignalOut[];
  composite: AltComposite;
}

export const getAltData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SymbolIn.parse(d))
  .handler(async ({ data }): Promise<AltDataResult> => {
    const { collectAltSignals, computeAltComposite } = await import("./altdata/providers.server");
    const raw = await collectAltSignals(data.symbol);
    const signals: AltSignalOut[] = raw.map(s => ({
      kind: String(s.kind), provider: s.provider,
      score: s.score, confidence: s.confidence,
      payload: (s.payload ?? {}) as Record<string, any>,
    }));
    return { symbol: data.symbol, signals, composite: computeAltComposite(raw) };
  });

export interface AltOverviewRow { symbol: string; composite: AltComposite }
export const getAltOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ overview: AltOverviewRow[] }> => {
    const { collectAltSignals, computeAltComposite } = await import("./altdata/providers.server");
    const symbols = listSupportedSymbols();
    const rows = await Promise.all(symbols.map(async sym => {
      const signals = await collectAltSignals(sym);
      return { symbol: sym, composite: computeAltComposite(signals) };
    }));
    rows.sort((a, b) => Math.abs(b.composite.score) - Math.abs(a.composite.score));
    return { overview: rows };
  });
