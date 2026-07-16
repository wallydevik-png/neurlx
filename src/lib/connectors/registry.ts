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
    displayName: "Binance",
    authType: "api_key",
    supportsRealTrading: true,
    description: "Global crypto exchange. Add API key with read-only scope by default. (Coming soon — connector stub only.)",
    credentialFields: [
      { key: "apiKey", label: "API Key", placeholder: "Your Binance API key" },
      { key: "apiSecret", label: "API Secret", secret: true, placeholder: "Your Binance API secret" },
    ],
  },
  {
    id: "coinbase",
    displayName: "Coinbase",
    authType: "oauth",
    supportsRealTrading: true,
    description: "OAuth-based read access to your Coinbase portfolio. (Coming soon — connector stub only.)",
  },
  {
    id: "kraken",
    displayName: "Kraken",
    authType: "api_key",
    supportsRealTrading: true,
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
