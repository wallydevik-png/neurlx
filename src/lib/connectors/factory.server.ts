// Server-only connector factory. Modular by design: each connector implements
// TradingConnector and is wired here.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialPayload, TradingConnector } from "./types";
import { createPaperConnector } from "./paper.server";
import { createBinanceConnector } from "./binance.server";
import { createGenericConnector } from "./generic.server";
import { getBroker } from "./brokerRegistry";

export interface ConnectorContext {
  supabase?: SupabaseClient;
  userId?: string;
  connectionId?: string | null;
  orderId?: string | null;
}

// Provider-agnostic dispatch. Each broker declared in brokerRegistry.ts is
// addressable here; new brokers only need a new module + registry entry, no
// changes to execution/portfolio/risk/mission-control.
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
    default: {
      if (!getBroker(connectorId)) {
        throw new Error(`Connector "${connectorId}" is not registered.`);
      }
      // Registered but not yet first-class — safe stub keeps the uniform interface.
      return createGenericConnector(connectorId);
    }
  }
}
