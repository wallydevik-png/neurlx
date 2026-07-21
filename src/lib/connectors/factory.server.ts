// Server-only connector factory. Modular by design: each connector implements
// TradingConnector and is wired here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialPayload, TradingConnector } from "./types";
import { createPaperConnector } from "./paper.server";
import { createBinanceConnector } from "./binance.server";

export interface ConnectorContext {
  supabase?: SupabaseClient;
  userId?: string;
  connectionId?: string | null;
  orderId?: string | null;
}

export function createConnector(
  connectorId: string,
  credentials: CredentialPayload,
  ctx: ConnectorContext = {},
): TradingConnector {
  switch (connectorId) {
    case "paper":
      return createPaperConnector();
    case "binance":
      return createBinanceConnector(credentials, ctx);
    default:
      throw new Error(`Connector "${connectorId}" is not yet available.`);
  }
}
