// Server-only connector factory. Modular by design: each connector implements
// TradingConnector and is wired here. `paper` is fully live; `binance` is
// READ-ONLY (market data + optional signed balance/history when API key +
// secret are supplied). No live trading is exposed in this build.
import type { CredentialPayload, TradingConnector } from "./types";
import { createPaperConnector } from "./paper.server";
import { createBinanceConnector } from "./binance.server";

export function createConnector(connectorId: string, credentials: CredentialPayload): TradingConnector {
  switch (connectorId) {
    case "paper":
      return createPaperConnector();
    case "binance":
      return createBinanceConnector(credentials);
    default:
      throw new Error(`Connector "${connectorId}" is not yet available. Use paper trading or Binance (read-only) instead.`);
  }
}
