// Server-only connector factory. Modular by design: each connector implements
// TradingConnector and is wired here.
//
// The dispatch table also routes every MT-only broker (Octa, Exness, IC
// Markets, Pepperstone, FP Markets, XM) through the single MT5 bridge —
// the broker name is preserved for the UI but the transport is universal.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CredentialPayload, TradingConnector } from "./types";
import { createPaperConnector } from "./paper.server";
import { createBinanceConnector } from "./binance.server";
import { createBybitConnector } from "./bybit.server";
import { createOkxConnector } from "./okx.server";
import { createKrakenConnector } from "./kraken.server";
import { createAlpacaConnector } from "./alpaca.server";
import { createOandaConnector } from "./oanda.server";
import { createMt5Connector } from "./mt5.server";
import { createGenericConnector } from "./generic.server";
import { getBroker } from "./brokerRegistry";

export interface ConnectorContext {
  supabase?: SupabaseClient;
  userId?: string;
  connectionId?: string | null;
  orderId?: string | null;
}

const MT_ROUTED = new Set([
  "mt5", "mt4", "octa", "exness", "icmarkets", "pepperstone", "fpmarkets", "xm",
]);

export function createConnector(
  connectorId: string,
  credentials: CredentialPayload,
  ctx: ConnectorContext = {},
): TradingConnector {
  if (MT_ROUTED.has(connectorId)) return createMt5Connector(connectorId, credentials, ctx);
  switch (connectorId) {
    case "paper":    return createPaperConnector();
    case "binance":  return createBinanceConnector(credentials, ctx);
    case "bybit":    return createBybitConnector(credentials, ctx);
    case "okx":      return createOkxConnector(credentials, ctx);
    case "kraken":   return createKrakenConnector(credentials, ctx);
    case "alpaca":   return createAlpacaConnector(credentials, ctx);
    case "oanda":    return createOandaConnector(credentials, ctx);
    default: {
      if (!getBroker(connectorId)) {
        throw new Error(`Connector "${connectorId}" is not registered.`);
      }
      return createGenericConnector(connectorId);
    }
  }
}
