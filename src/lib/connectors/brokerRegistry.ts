// Universal Broker & Exchange Integration Hub — client-safe registry.
// Each entry declares ONLY officially-supported authentication methods and
// documented capabilities. New brokers can be added here without changing
// any other part of NeurlX (execution engine, portfolio, risk, mission
// control) because they all consume connectors through the same interface.

export type BrokerCategory = "crypto" | "forex_cfd" | "stocks_multi";
export type AuthMethod = "oauth" | "api_key" | "metatrader" | "sdk" | "paper";
export type AssetClass =
  | "crypto_spot" | "crypto_perp" | "crypto_futures"
  | "forex" | "cfd" | "commodities" | "indices"
  | "stocks" | "options" | "futures";
export type OrderTypeSupported =
  | "market" | "limit" | "stop_loss" | "take_profit"
  | "stop_limit" | "trailing_stop" | "oco";

export interface CredentialField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  helper?: string;
  optional?: boolean;
}

export interface BrokerDescriptor {
  id: string;
  displayName: string;
  category: BrokerCategory;
  authMethod: AuthMethod;
  supportsRealTrading: boolean;
  /** True when NeurlX has a first-class server connector for this broker. */
  implemented: boolean;
  assetClasses: AssetClass[];
  orderTypes: OrderTypeSupported[];
  description: string;
  /** Short note explaining WHY this auth method — helps users understand. */
  authNote: string;
  /** Only shown for api_key / metatrader auth methods. */
  credentialFields?: CredentialField[];
  /** Only shown for MetaTrader — list of typical broker server hostnames. */
  metatraderServers?: string[];
  /** Official docs URL for the auth flow (shown as a "Learn more" link). */
  docsUrl?: string;
}

const OT_STANDARD: OrderTypeSupported[] = [
  "market", "limit", "stop_loss", "take_profit", "stop_limit",
];

// ---------------- Crypto Exchanges ----------------
const CRYPTO: BrokerDescriptor[] = [
  {
    id: "binance", displayName: "Binance", category: "crypto",
    authMethod: "api_key", supportsRealTrading: true, implemented: true,
    assetClasses: ["crypto_spot", "crypto_perp"],
    orderTypes: [...OT_STANDARD, "trailing_stop", "oco"],
    description: "Binance Spot & Futures via official signed REST API.",
    authNote: "Binance issues API keys from Account → API Management. NeurlX only accepts keys with reading and (optionally) spot trading — never withdrawal.",
    credentialFields: [
      { key: "apiKey", label: "API Key (read + spot trading)", placeholder: "Optional — leave blank for public prices only", optional: true },
      { key: "apiSecret", label: "API Secret", secret: true, placeholder: "Required if API Key is provided", optional: true },
    ],
    docsUrl: "https://www.binance.com/en/support/faq/how-to-create-api-360002502072",
  },
  {
    id: "coinbase", displayName: "Coinbase Advanced Trade", category: "crypto",
    authMethod: "oauth", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot"],
    orderTypes: [...OT_STANDARD],
    description: "Coinbase Advanced Trade via official OAuth flow.",
    authNote: "Coinbase supports OAuth 2.0 for third-party apps. You'll be redirected to Coinbase to approve read + trade scopes. Withdrawal scope is never requested.",
    docsUrl: "https://docs.cloud.coinbase.com/exchange/docs/authorization-and-authentication",
  },
  {
    id: "kraken", displayName: "Kraken", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_futures"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Kraken Spot & Futures via signed REST API.",
    authNote: "Generate a Kraken API key with Query Funds + Query/Cancel/Create Orders. Never enable Withdraw Funds.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "Private Key", secret: true },
    ],
    docsUrl: "https://support.kraken.com/hc/en-us/articles/360000919966",
  },
  {
    id: "bybit", displayName: "Bybit", category: "crypto",
    authMethod: "api_key", supportsRealTrading: true, implemented: true,
    assetClasses: ["crypto_spot", "crypto_perp", "crypto_futures"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Bybit Unified Trading Account via official REST API.",
    authNote: "Create a system-generated API key with Read + Trade permissions. NeurlX rejects keys with Withdraw enabled.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "API Secret", secret: true },
    ],
    docsUrl: "https://bybit-exchange.github.io/docs/v5/intro",
  },
  {
    id: "okx", displayName: "OKX", category: "crypto",
    authMethod: "api_key", supportsRealTrading: true, implemented: true,
    assetClasses: ["crypto_spot", "crypto_perp", "crypto_futures", "options"],
    orderTypes: [...OT_STANDARD, "trailing_stop", "oco"],
    description: "OKX Unified Account via signed REST API (v5).",
    authNote: "OKX API keys require an additional passphrase set at creation time. Use Read + Trade only.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "Secret Key", secret: true },
      { key: "passphrase", label: "Passphrase", secret: true, helper: "Set when you created the API key." },
    ],
    docsUrl: "https://www.okx.com/docs-v5/en/",
  },
  {
    id: "kucoin", displayName: "KuCoin", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_futures"],
    orderTypes: [...OT_STANDARD],
    description: "KuCoin Spot & Futures via signed REST API.",
    authNote: "KuCoin API keys use key + secret + passphrase. Grant General + Trade only.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "API Secret", secret: true },
      { key: "passphrase", label: "API Passphrase", secret: true },
    ],
    docsUrl: "https://www.kucoin.com/docs/",
  },
  {
    id: "bitget", displayName: "Bitget", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_perp"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Bitget Spot & Perp via signed REST API.",
    authNote: "Bitget API keys use key + secret + passphrase. Read + Trade only.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "Secret Key", secret: true },
      { key: "passphrase", label: "Passphrase", secret: true },
    ],
    docsUrl: "https://www.bitget.com/api-doc/common/intro",
  },
  {
    id: "gateio", displayName: "Gate.io", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_perp", "crypto_futures"],
    orderTypes: [...OT_STANDARD],
    description: "Gate.io Spot & Perp via signed REST API (v4).",
    authNote: "Gate.io API keys support per-permission scoping. Enable Spot/Perp Trade only.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "Secret", secret: true },
    ],
    docsUrl: "https://www.gate.io/docs/developers/apiv4/",
  },
  {
    id: "htx", displayName: "HTX (Huobi)", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_futures"],
    orderTypes: [...OT_STANDARD],
    description: "HTX (formerly Huobi) via signed REST API.",
    authNote: "Create an API key with Read + Trade. IP whitelisting is strongly recommended by HTX.",
    credentialFields: [
      { key: "apiKey", label: "Access Key" },
      { key: "apiSecret", label: "Secret Key", secret: true },
    ],
    docsUrl: "https://huobiapi.github.io/docs/spot/v1/en/",
  },
  {
    id: "mexc", displayName: "MEXC", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_perp"],
    orderTypes: [...OT_STANDARD],
    description: "MEXC Spot & Perp via signed REST API.",
    authNote: "MEXC API keys are scoped per-permission. Enable Read + Spot Trading only.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "API Secret", secret: true },
    ],
    docsUrl: "https://mexcdevelop.github.io/apidocs/spot_v3_en/",
  },
  {
    id: "cryptocom", displayName: "Crypto.com Exchange", category: "crypto",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["crypto_spot", "crypto_perp"],
    orderTypes: [...OT_STANDARD],
    description: "Crypto.com Exchange via signed REST API.",
    authNote: "Crypto.com Exchange (not the App) issues API keys under User Center → API. Read + Trade only.",
    credentialFields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "Secret Key", secret: true },
    ],
    docsUrl: "https://exchange-docs.crypto.com/",
  },
];

// ---------------- Forex & CFD Brokers ----------------
// Note: Octa, Exness, IC Markets, Pepperstone, FP Markets, XM are almost
// always connected through the broker's MetaTrader 5 (or MT4) server —
// they do not publish public REST/OAuth trading APIs. NeurlX detects the
// broker and presents the MetaTrader flow with the correct server hint.
const FOREX: BrokerDescriptor[] = [
  {
    id: "mt5", displayName: "MetaTrader 5 (Any Broker)", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices", "stocks"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Universal MT5 bridge — works with any broker that offers a MetaTrader 5 server.",
    authNote: "NeurlX connects through the official MetaQuotes MT5 gateway. You provide your MT5 login, investor or trading password, and your broker's MT5 server hostname (shown in your MT5 terminal under File → Login to Trade Account).",
    credentialFields: [
      { key: "login", label: "MT5 Login (account number)", placeholder: "e.g. 51234567" },
      { key: "password", label: "MT5 Password", secret: true, helper: "Use investor password for read-only, trading password to allow orders." },
      { key: "server", label: "Broker Server", placeholder: "e.g. ICMarkets-Live22" },
    ],
    docsUrl: "https://www.metatrader5.com/en/terminal/help/start_advanced/start",
  },
  {
    id: "mt4", displayName: "MetaTrader 4 (Legacy)", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: ["market", "limit", "stop_loss", "take_profit", "trailing_stop"],
    description: "MT4 bridge for brokers still on MetaTrader 4. New accounts should prefer MT5.",
    authNote: "Same flow as MT5 but through the MT4 protocol. Provide login, password, and your broker's MT4 server hostname.",
    credentialFields: [
      { key: "login", label: "MT4 Login" },
      { key: "password", label: "MT4 Password", secret: true },
      { key: "server", label: "Broker Server", placeholder: "e.g. Pepperstone-Live04" },
    ],
    docsUrl: "https://www.metatrader4.com/en/trading-platform",
  },
  {
    id: "octa", displayName: "Octa", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Octa via MetaTrader 5 — Octa does not publish a public trading API.",
    authNote: "Octa is connected through its MetaTrader 5 server. You'll use your Octa MT5 login and password. NeurlX never asks for your Octa website password.",
    credentialFields: [
      { key: "login", label: "Octa MT5 Login" },
      { key: "password", label: "Octa MT5 Password", secret: true },
    ],
    metatraderServers: ["OctaFX-Real", "OctaFX-Demo"],
  },
  {
    id: "exness", displayName: "Exness", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices", "crypto_spot"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Exness via MetaTrader 5 (or MT4 on legacy accounts).",
    authNote: "Exness accounts connect through the Exness MT5 server. Your MT5 login is different from your Exness Personal Area password.",
    credentialFields: [
      { key: "login", label: "Exness MT5 Login" },
      { key: "password", label: "MT5 Password", secret: true },
    ],
    metatraderServers: ["Exness-Real", "Exness-Real2", "Exness-Trial", "Exness-MT5Real", "Exness-MT5Trial"],
  },
  {
    id: "icmarkets", displayName: "IC Markets", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "IC Markets via MetaTrader 5 / cTrader server.",
    authNote: "IC Markets exposes trading via MT5. Provide your MT5 login and choose your assigned server (shown in the confirmation email).",
    credentialFields: [
      { key: "login", label: "MT5 Login" },
      { key: "password", label: "MT5 Password", secret: true },
    ],
    metatraderServers: ["ICMarketsSC-Live22", "ICMarketsSC-Live04", "ICMarketsSC-Demo02"],
  },
  {
    id: "pepperstone", displayName: "Pepperstone", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Pepperstone via MetaTrader 5.",
    authNote: "Use your Pepperstone MT5 login. Live and demo accounts use different server hostnames.",
    credentialFields: [
      { key: "login", label: "MT5 Login" },
      { key: "password", label: "MT5 Password", secret: true },
    ],
    metatraderServers: ["Pepperstone-MT5-Live04", "Pepperstone-Demo"],
  },
  {
    id: "fpmarkets", displayName: "FP Markets", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices", "stocks"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "FP Markets via MetaTrader 5.",
    authNote: "FP Markets exposes trading via MT5. Provide your MT5 login and your assigned server.",
    credentialFields: [
      { key: "login", label: "MT5 Login" },
      { key: "password", label: "MT5 Password", secret: true },
    ],
    metatraderServers: ["FPMarkets-Live", "FPMarkets-Demo"],
  },
  {
    id: "xm", displayName: "XM", category: "forex_cfd",
    authMethod: "metatrader", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "XM via MetaTrader 5 (or MT4).",
    authNote: "XM connects through the XM MT5 server. Your MT5 login is included in the account confirmation email.",
    credentialFields: [
      { key: "login", label: "MT5 Login" },
      { key: "password", label: "MT5 Password", secret: true },
    ],
    metatraderServers: ["XMGlobal-MT5", "XMGlobal-MT5 2", "XMGlobal-Demo"],
  },
  {
    id: "oanda", displayName: "OANDA", category: "forex_cfd",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "OANDA v20 REST API — one of the few forex brokers with a first-class REST API.",
    authNote: "Generate a personal access token at Manage API Access in your OANDA account. Read + Trade scopes are sufficient.",
    credentialFields: [
      { key: "accessToken", label: "Personal Access Token", secret: true },
      { key: "accountId", label: "OANDA Account ID", placeholder: "e.g. 001-001-1234567-001" },
      { key: "environment", label: "Environment", placeholder: "practice or live", helper: "Use 'practice' for OANDA fxTrade Practice, 'live' for real accounts." },
    ],
    docsUrl: "https://developer.oanda.com/rest-live-v20/introduction/",
  },
  {
    id: "fxcm", displayName: "FXCM", category: "forex_cfd",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "FXCM ForexConnect / REST API via personal access token.",
    authNote: "Generate a REST API token in FXCM Trading Station → Account → Token Management.",
    credentialFields: [
      { key: "accessToken", label: "REST API Token", secret: true },
      { key: "environment", label: "Environment", placeholder: "demo or real" },
    ],
    docsUrl: "https://github.com/fxcm/RestAPI",
  },
];

// ---------------- Stocks & Multi-Asset Brokers ----------------
const STOCKS: BrokerDescriptor[] = [
  {
    id: "ibkr", displayName: "Interactive Brokers", category: "stocks_multi",
    authMethod: "sdk", supportsRealTrading: false, implemented: false,
    assetClasses: ["stocks", "options", "futures", "forex", "cfd", "commodities", "indices"],
    orderTypes: [...OT_STANDARD, "trailing_stop", "oco"],
    description: "Interactive Brokers via the official Client Portal Gateway (CPAPI).",
    authNote: "IBKR requires the official Client Portal Gateway to be running (local or hosted). You'll authenticate directly with IBKR in a browser and NeurlX talks to your local gateway. NeurlX never sees your IBKR password.",
    credentialFields: [
      { key: "gatewayUrl", label: "Gateway URL", placeholder: "https://localhost:5000", helper: "Address where your Client Portal Gateway is reachable." },
      { key: "accountId", label: "IBKR Account ID", placeholder: "e.g. U1234567" },
    ],
    docsUrl: "https://www.interactivebrokers.com/en/trading/ib-api.php",
  },
  {
    id: "alpaca", displayName: "Alpaca", category: "stocks_multi",
    authMethod: "api_key", supportsRealTrading: false, implemented: false,
    assetClasses: ["stocks", "options", "crypto_spot"],
    orderTypes: [...OT_STANDARD, "trailing_stop"],
    description: "Alpaca Trading API — commission-free US stocks, options, and crypto.",
    authNote: "Generate API keys in the Alpaca dashboard. Paper trading and live keys are separate — pick the environment that matches the key.",
    credentialFields: [
      { key: "apiKey", label: "API Key ID" },
      { key: "apiSecret", label: "Secret Key", secret: true },
      { key: "environment", label: "Environment", placeholder: "paper or live" },
    ],
    docsUrl: "https://alpaca.markets/docs/",
  },
  {
    id: "tradier", displayName: "Tradier", category: "stocks_multi",
    authMethod: "oauth", supportsRealTrading: false, implemented: false,
    assetClasses: ["stocks", "options"],
    orderTypes: [...OT_STANDARD, "trailing_stop", "oco"],
    description: "Tradier Brokerage via official OAuth 2.0 flow.",
    authNote: "Tradier supports OAuth 2.0 for third-party apps. You'll be redirected to Tradier to approve market data + trade scopes.",
    docsUrl: "https://documentation.tradier.com/brokerage-api/oauth/getting-started",
  },
  {
    id: "tradestation", displayName: "TradeStation", category: "stocks_multi",
    authMethod: "oauth", supportsRealTrading: false, implemented: false,
    assetClasses: ["stocks", "options", "futures", "crypto_spot"],
    orderTypes: [...OT_STANDARD, "trailing_stop", "oco"],
    description: "TradeStation via official OAuth 2.0 flow.",
    authNote: "TradeStation uses OAuth 2.0 with refresh tokens. NeurlX stores an encrypted refresh token and rotates access tokens automatically.",
    docsUrl: "https://api.tradestation.com/docs/",
  },
];

// ---------------- Paper (always available) ----------------
const PAPER: BrokerDescriptor = {
  id: "paper", displayName: "Paper Trading", category: "crypto",
  authMethod: "paper", supportsRealTrading: false, implemented: true,
  assetClasses: ["crypto_spot", "stocks"],
  orderTypes: [...OT_STANDARD],
  description: "Simulated exchange with realistic fees & slippage. The safest starting point.",
  authNote: "No credentials required. Paper accounts start with $100,000 in simulated cash.",
};

export const BROKERS: BrokerDescriptor[] = [PAPER, ...CRYPTO, ...FOREX, ...STOCKS];

export const BROKER_CATEGORIES: { id: BrokerCategory | "paper"; label: string; blurb: string }[] = [
  { id: "paper",       label: "Paper Trading",    blurb: "Zero-risk simulation. Start here." },
  { id: "crypto",      label: "Crypto Exchanges", blurb: "Spot, perp, and futures venues." },
  { id: "forex_cfd",   label: "Forex & CFD",      blurb: "MetaTrader 5/4 and REST brokers." },
  { id: "stocks_multi",label: "Stocks & Multi-Asset", blurb: "Equities, options, futures." },
];

export function getBroker(id: string): BrokerDescriptor | undefined {
  return BROKERS.find(b => b.id === id);
}

export function brokersByCategory(cat: BrokerCategory | "paper"): BrokerDescriptor[] {
  if (cat === "paper") return [PAPER];
  return BROKERS.filter(b => b.category === cat && b.id !== "paper");
}
