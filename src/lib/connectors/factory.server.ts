// Server-only connector factory. Only `paper` is wired in v1.
import type { CredentialPayload, TradingConnector } from "./types";
import { createPaperConnector } from "./paper.server";

export function createConnector(connectorId: string, _credentials: CredentialPayload): TradingConnector {
  switch (connectorId) {
    case "paper":
      return createPaperConnector();
    default:
      throw new Error(`Connector "${connectorId}" is not yet available for live trading. Use paper trading first.`);
  }
}
