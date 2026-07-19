// Client-safe connector catalog (descriptors only — no server logic).
import type { ConnectorDescriptor } from "./types";

export const CONNECTORS: ConnectorDescriptor[] = [
  {
    id: "paper",
    displayName: "Paper Trading",
    authType: "paper",
    supportsRealTrading: false,
    description: "Simulated exchange with realistic fees & slippage. Perfect for practice and strategy validation before going live.",
  },
  {
    id: "binance",
    displayName: "Binance (Read-Only)",
    authType: "api_key",
    supportsRealTrading: false,
    description: "Live market data + your real balances and trade history. Read-only — this build never places live orders and never requests withdrawal permission. Leave keys blank for public market data only.",
    credentialFields: [
      { key: "apiKey", label: "API Key (read-only)", placeholder: "Optional — leave blank for public prices only" },
      { key: "apiSecret", label: "API Secret", secret: true, placeholder: "Required if API Key is provided" },
    ],
  },
  {
    id: "coinbase",
    displayName: "Coinbase",
    authType: "oauth",
    supportsRealTrading: false,
    description: "OAuth-based read access to your Coinbase portfolio. (Coming soon — connector stub only.)",
  },
  {
    id: "kraken",
    displayName: "Kraken",
    authType: "api_key",
    supportsRealTrading: false,
    description: "API-key access to Kraken spot markets. (Coming soon — connector stub only.)",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "Private Key", secret: true },
    ],
  },
];

export function getConnectorDescriptor(id: string): ConnectorDescriptor | undefined {
  return CONNECTORS.find(c => c.id === id);
}
