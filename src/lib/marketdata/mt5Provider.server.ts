// Bridges a user's connected MetaTrader (MT5/MT4, or any MT-routed broker —
// Octa, Exness, IC Markets, Pepperstone, FP Markets, XM) account into the
// generic MarketDataProvider interface used by the AI signal engine.
//
// Why this file exists: market data (service.server.ts) used to be a global,
// credential-less facade (Bybit public API + synthetic fallback). MT5 data is
// inherently tied to one specific user's broker account, so resolving "which
// provider" now requires knowing *which user* is asking. This module is the
// only place that bridges that gap — it looks up the user's connection,
// decrypts credentials, and hands back a ready MarketDataProvider plus the
// broker's real tradable symbol list.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MarketDataProvider, Interval, MarketDataRequestOptions } from "./types";
import type { TradingConnector } from "@/lib/connectors/types";

const MT_ROUTED = new Set([
  "mt5", "mt4", "octa", "exness", "icmarkets", "pepperstone", "fpmarkets", "xm",
]);

// Connector construction re-provisions/re-fetches account state, which is
// expensive and rate-limited on MetaApi's side (see mt5.server.ts's own
// caching notes) — cache the resolved connector per user briefly so a scan
// across many symbols doesn't reconnect per symbol.
const connectorCache = new Map<string, { at: number; connector: TradingConnector | null }>();
const CONNECTOR_TTL_MS = 5 * 60 * 1000;

/** Finds the user's active MT-routed connection (if any), decrypts its
 *  credentials, and returns a ready TradingConnector. Returns null if the
 *  user has no MetaTrader-family connection connected — callers should treat
 *  that as "no live broker data available", not as an error. */
export async function resolveUserMt5Connector(
  supabase: SupabaseClient | null,
  userId: string | null | undefined,
): Promise<TradingConnector | null> {
  if (!supabase || !userId) return null;

  const cached = connectorCache.get(userId);
  if (cached && Date.now() - cached.at < CONNECTOR_TTL_MS) return cached.connector;

  const { data: conns } = await supabase.from("exchange_connections")
    .select("id,connector_id,status,read_enabled,credential_ciphertext,updated_at")
    .eq("user_id", userId)
    .eq("status", "connected")
    .eq("read_enabled", true)
    .order("updated_at", { ascending: false });

  const conn = (conns ?? []).find(c => MT_ROUTED.has(c.connector_id));
  if (!conn) {
    connectorCache.set(userId, { at: Date.now(), connector: null });
    return null;
  }

  try {
    const { decryptJSON } = await import("@/lib/crypto.server");
    const { createConnector } = await import("@/lib/connectors/factory.server");
    const creds = conn.credential_ciphertext
      ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext)
      : {};
    const connector = createConnector(conn.connector_id, creds, {
      supabase, userId, connectionId: conn.id,
    });
    connectorCache.set(userId, { at: Date.now(), connector });
    return connector;
  } catch (e) {
    console.warn("[mt5Provider] failed to build connector for user", userId,
      e instanceof Error ? e.message : String(e));
    connectorCache.set(userId, { at: Date.now(), connector: null });
    return null;
  }
}

/** Wraps a resolved MT connector as a MarketDataProvider. `supports()` is
 *  optimistic (always true) — since this provider only exists when the user
 *  already has a connected broker, and the connector itself throws
 *  UnsupportedSymbolError for instruments the broker doesn't list, which the
 *  market-data facade's try/catch already handles by moving to the next
 *  provider (or surfacing the failure, per caller). */
export function createMt5MarketDataProvider(connector: TradingConnector): MarketDataProvider | null {
  if (!connector.getCandles) return null; // connector doesn't support candle history
  const getCandles = connector.getCandles.bind(connector);
  const getQuoteFn = connector.getQuote.bind(connector);
  return {
    id: `mt5:${connector.id}`,
    displayName: `${connector.displayName} (live)`,
    supports: () => true,
    async getCandles(
      symbol: string, interval: Interval, limit: number,
      opts?: MarketDataRequestOptions,
    ) {
      // Cancellation/budget flows straight through to the connector so an
      // expired cycle really cancels the provider request instead of leaving
      // it running into the next cron tick.
      const candles = await getCandles(symbol, interval, limit, opts);
      return candles;
    },
    async getLastPrice(symbol: string) {
      const q = await getQuoteFn(symbol);
      return q.mid;
    },
  };
}

/** The broker's real tradable symbol universe for this user, in NeurlX
 *  "BASE-QUOTE" form. Returns null if the user has no connected MT account
 *  (or its connector doesn't expose a symbol list) so callers know to fall
 *  back to the static list instead of an empty scan. */
export async function listMt5TradableSymbols(
  supabase: SupabaseClient | null,
  userId: string | null | undefined,
): Promise<string[] | null> {
  const connector = await resolveUserMt5Connector(supabase, userId);
  if (!connector?.listSymbols) return null;
  try {
    const symbols = await connector.listSymbols();
    return symbols.length ? symbols : null;
  } catch (e) {
    console.warn("[mt5Provider] listSymbols failed", e instanceof Error ? e.message : String(e));
    return null;
  }
}
