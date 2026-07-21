// Market Intelligence server functions.
// Refresh reads through providers (deterministic per 30-min bucket), caches
// into public.market_intel, and returns computed consensus.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { collectSignals } from "./intel/providers.server";
import { computeConsensus, type Consensus } from "./intel/consensus.server";
import { listSupportedSymbols } from "./marketdata/service.server";

const SymbolIn = z.object({ symbol: z.string().min(1).max(32) });

export interface IntelSignalOut {
  provider: string;
  kind: string;
  score: number;
  confidence: number;
  payload: Record<string, any>;
}
export interface IntelResult {
  symbol: string;
  signals: IntelSignalOut[];
  consensus: Consensus;
  cached: boolean;
}

async function refreshOne(supabase: any, symbol: string): Promise<{ signals: IntelSignalOut[]; consensus: Consensus }> {
  const signals = await collectSignals(symbol);
  const out: IntelSignalOut[] = signals.map(s => ({
    provider: s.provider, kind: String(s.kind),
    score: s.score, confidence: s.confidence,
    payload: (s.payload ?? {}) as Record<string, any>,
  }));
  const rows = out.map(s => ({
    symbol, provider: s.provider, kind: s.kind,
    score: s.score, confidence: s.confidence,
    payload: s.payload,
    ts: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }));
  if (rows.length) {
    try {
      await (supabase as any).from("market_intel").upsert(rows, { onConflict: "symbol,provider,kind,ts" });
    } catch { /* best-effort cache */ }
  }
  return { signals: out, consensus: computeConsensus(signals) };
}

export const getMarketIntel = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SymbolIn.parse(d))
  .handler(async ({ data, context }): Promise<IntelResult> => {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: cached } = await (context.supabase as any)
      .from("market_intel")
      .select("*")
      .eq("symbol", data.symbol)
      .gte("ts", cutoff)
      .order("ts", { ascending: false });
    const seen = new Set<string>();
    const dedup: IntelSignalOut[] = [];
    for (const r of (cached ?? []) as any[]) {
      const k = `${r.provider}:${r.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push({
        provider: r.provider, kind: r.kind,
        score: Number(r.score), confidence: Number(r.confidence),
        payload: (r.payload ?? {}) as Record<string, any>,
      });
    }
    if (dedup.length === 0) {
      const fresh = await refreshOne(context.supabase, data.symbol);
      return { symbol: data.symbol, signals: fresh.signals, consensus: fresh.consensus, cached: false };
    }
    // Rebuild consensus from cached signals
    const consensus = computeConsensus(dedup.map(s => ({
      provider: s.provider, kind: s.kind as any,
      score: s.score, confidence: s.confidence, payload: s.payload,
    })));
    return { symbol: data.symbol, signals: dedup, consensus, cached: true };
  });

export const refreshMarketIntel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => SymbolIn.parse(d))
  .handler(async ({ data, context }): Promise<IntelResult> => {
    const { signals, consensus } = await refreshOne(context.supabase, data.symbol);
    return { symbol: data.symbol, signals, consensus, cached: false };
  });

export interface OverviewRow { symbol: string; consensus: Consensus }
export const getIntelOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ overview: OverviewRow[] }> => {
    const symbols = listSupportedSymbols();
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data: rows } = await (context.supabase as any)
      .from("market_intel").select("symbol,provider,kind,score,confidence,ts,payload")
      .in("symbol", symbols).gte("ts", cutoff);
    const grouped: Record<string, any[]> = {};
    for (const r of (rows ?? []) as any[]) {
      if (!grouped[r.symbol]) grouped[r.symbol] = [];
      grouped[r.symbol].push({
        provider: r.provider, kind: r.kind,
        score: Number(r.score), confidence: Number(r.confidence),
        payload: r.payload ?? {}, ts: r.ts,
      });
    }
    const missing = symbols.filter(s => !grouped[s]);
    await Promise.all(missing.map(async s => {
      const fresh = await refreshOne(context.supabase, s);
      grouped[s] = fresh.signals.map(x => ({ ...x, ts: new Date().toISOString() }));
    }));
    const overview: OverviewRow[] = symbols.map(sym => {
      const seen = new Set<string>();
      const sigs = (grouped[sym] ?? [])
        .sort((a: any, b: any) => (b.ts ?? "").localeCompare(a.ts ?? ""))
        .filter((s: any) => { const k = `${s.provider}:${s.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
      return { symbol: sym, consensus: computeConsensus(sigs) };
    });
    overview.sort((a, b) => Math.abs(b.consensus.score) - Math.abs(a.consensus.score));
    return { overview };
  });
