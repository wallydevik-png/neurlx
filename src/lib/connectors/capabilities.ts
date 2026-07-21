// Provider Capability Registry — client-safe.
//
// Every broker/exchange registered in brokerRegistry.ts has a capability
// entry here describing what its official API actually supports. Consumers
// (UI badges, wizard, execution engine, test suite) read this instead of
// hard-coding assumptions, so adding a new broker is: (1) descriptor in
// brokerRegistry.ts, (2) capability row here, (3) server connector module.
//
// Capabilities are **declarative facts** about the venue's public documented
// API. `implemented: false` means the venue is documented but NeurlX has
// not yet shipped the first-class server connector — the generic stub still
// runs, but capability badges reflect the future contract, not the stub.

import type { AssetClass, OrderTypeSupported } from "./brokerRegistry";

export interface RateLimit {
  /** Requests per second, aggregated (documented safe budget). */
  perSecond: number;
  /** Weight-based venues expose a per-minute allowance too. */
  perMinute?: number;
}

export interface ConnectorCapabilities {
  brokerId: string;

  // --- auth ---
  authentication: "oauth" | "api_key" | "metatrader" | "sdk" | "paper" | "bridge";
  supportsTokenRotation: boolean;
  supportsIpAllowlist: boolean;

  // --- data ---
  read: boolean;
  marketData: boolean;
  historicalData: boolean;
  websocket: boolean;

  // --- trading ---
  trading: boolean;
  orderManagement: boolean;         // place / modify / cancel
  positionSync: boolean;
  accountSync: boolean;             // balances, equity, margin
  withdrawalsReadOnly: boolean;     // can we SEE (never move) fiat/crypto flows

  // --- market coverage ---
  assetClasses: AssetClass[];
  orderTypes: OrderTypeSupported[];
  rateLimit: RateLimit;

  // --- deployment status in NeurlX ---
  /** True when a first-class server module implements this connector. */
  implemented: boolean;
  /** Public docs anchor for the auth flow, shown in the wizard. */
  docsUrl?: string;
  /** One-line summary shown next to the badge cluster. */
  summary: string;
}

const STANDARD_ORDERS: OrderTypeSupported[] = [
  "market", "limit", "stop_loss", "take_profit", "stop_limit",
];

const CAPABILITIES: ConnectorCapabilities[] = [
  {
    brokerId: "paper",
    authentication: "paper",
    supportsTokenRotation: false, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: false,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: false,
    assetClasses: ["crypto_spot", "stocks"],
    orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 100 },
    implemented: true,
    summary: "Simulated venue. Unlimited local execution with realistic fees & slippage.",
  },
  // ---------- Crypto (production connectors) ----------
  {
    brokerId: "binance",
    authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop", "oco"],
    rateLimit: { perSecond: 20, perMinute: 1200 },
    implemented: true,
    docsUrl: "https://binance-docs.github.io/apidocs/spot/en/",
    summary: "Signed REST + WebSocket, IP allowlist, per-order clientOrderId idempotency.",
  },
  {
    brokerId: "bybit",
    authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp", "crypto_futures"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop"],
    rateLimit: { perSecond: 10 },
    implemented: true,
    docsUrl: "https://bybit-exchange.github.io/docs/v5/intro",
    summary: "Bybit v5 unified account, HMAC-SHA256 signed, IP allowlist supported.",
  },
  {
    brokerId: "okx",
    authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp", "crypto_futures", "options"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop", "oco"],
    rateLimit: { perSecond: 20 },
    implemented: true,
    docsUrl: "https://www.okx.com/docs-v5/en/",
    summary: "OKX v5, key + secret + passphrase, HMAC-SHA256 base64 signed.",
  },
  {
    brokerId: "kraken",
    authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_futures"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop"],
    rateLimit: { perSecond: 1 },
    implemented: true,
    docsUrl: "https://docs.kraken.com/api/",
    summary: "Kraken REST, HMAC-SHA512(base64) with SHA256 nonce+body — signed per docs.",
  },
  {
    brokerId: "coinbase",
    authentication: "oauth",
    supportsTokenRotation: true, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot"],
    orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 10 },
    implemented: false,
    docsUrl: "https://docs.cdp.coinbase.com/advanced-trade/docs/welcome",
    summary: "OAuth 2.0 read-only wired. CDP EC-JWT trading pending first-class rollout.",
  },
  {
    brokerId: "kucoin", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_futures"], orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 8 }, implemented: false,
    docsUrl: "https://www.kucoin.com/docs/",
    summary: "Public market data live; signed trading routes pending first-class rollout.",
  },
  {
    brokerId: "bitget", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp"], orderTypes: [...STANDARD_ORDERS, "trailing_stop"],
    rateLimit: { perSecond: 10 }, implemented: false,
    docsUrl: "https://www.bitget.com/api-doc/common/intro",
    summary: "Public market data live; signed trading routes pending first-class rollout.",
  },
  {
    brokerId: "gateio", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp", "crypto_futures"], orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 10 }, implemented: false,
    docsUrl: "https://www.gate.io/docs/developers/apiv4/",
    summary: "Public market data live; signed trading routes pending first-class rollout.",
  },
  {
    brokerId: "htx", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_futures"], orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 10 }, implemented: false,
    docsUrl: "https://huobiapi.github.io/docs/spot/v1/en/",
    summary: "Public market data live; signed trading routes pending first-class rollout.",
  },
  {
    brokerId: "mexc", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp"], orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 20 }, implemented: false,
    docsUrl: "https://mexcdevelop.github.io/apidocs/spot_v3_en/",
    summary: "Public market data live; signed trading routes pending first-class rollout.",
  },
  {
    brokerId: "cryptocom", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["crypto_spot", "crypto_perp"], orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 10 }, implemented: false,
    docsUrl: "https://exchange-docs.crypto.com/",
    summary: "Public market data live; signed trading routes pending first-class rollout.",
  },
  // ---------- Forex / CFD ----------
  {
    brokerId: "mt5", authentication: "bridge",
    supportsTokenRotation: true, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: false,
    assetClasses: ["forex", "cfd", "commodities", "indices", "stocks"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop"],
    rateLimit: { perSecond: 5 }, implemented: true,
    docsUrl: "https://metaapi.cloud/docs/",
    summary: "MT5 via the official MetaApi cloud bridge — token-based, works with any MT5 broker.",
  },
  {
    brokerId: "mt4", authentication: "bridge",
    supportsTokenRotation: true, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: ["market", "limit", "stop_loss", "take_profit", "trailing_stop"],
    rateLimit: { perSecond: 5 }, implemented: true,
    docsUrl: "https://metaapi.cloud/docs/",
    summary: "MT4 via the official MetaApi cloud bridge (legacy). Same bridge as MT5.",
  },
  // Every MT-only broker uses the MT5/MT4 connector under the hood.
  ...(["octa", "exness", "icmarkets", "pepperstone", "fpmarkets", "xm"] as const).map(id => ({
    brokerId: id, authentication: "bridge" as const,
    supportsTokenRotation: true, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: false,
    assetClasses: ["forex", "cfd", "commodities", "indices"] as AssetClass[],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop"] as OrderTypeSupported[],
    rateLimit: { perSecond: 5 }, implemented: true,
    summary: "Routed automatically through NeurlX's MT5 bridge — the broker's official trading protocol.",
  })),
  {
    brokerId: "oanda", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["forex", "cfd", "commodities", "indices"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop"],
    rateLimit: { perSecond: 100 }, implemented: true,
    docsUrl: "https://developer.oanda.com/rest-live-v20/introduction/",
    summary: "OANDA v20 REST — bearer token, first-class REST forex broker.",
  },
  {
    brokerId: "fxcm", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["forex", "cfd", "commodities", "indices"], orderTypes: STANDARD_ORDERS,
    rateLimit: { perSecond: 30 }, implemented: false,
    docsUrl: "https://github.com/fxcm/RestAPI",
    summary: "REST token flow scaffolded; signed trading pending first-class rollout.",
  },
  // ---------- Stocks / Multi-asset ----------
  {
    brokerId: "alpaca", authentication: "api_key",
    supportsTokenRotation: false, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: true, orderManagement: true, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["stocks", "options", "crypto_spot"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop"],
    rateLimit: { perSecond: 200 }, implemented: true,
    docsUrl: "https://alpaca.markets/docs/",
    summary: "Alpaca REST — header-key auth, paper and live are separate environments.",
  },
  {
    brokerId: "tradier", authentication: "oauth",
    supportsTokenRotation: true, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["stocks", "options"], orderTypes: [...STANDARD_ORDERS, "trailing_stop", "oco"],
    rateLimit: { perSecond: 60 }, implemented: false,
    docsUrl: "https://documentation.tradier.com/",
    summary: "OAuth 2.0 read-only wired; signed trading pending first-class rollout.",
  },
  {
    brokerId: "tradestation", authentication: "oauth",
    supportsTokenRotation: true, supportsIpAllowlist: false,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["stocks", "options", "futures", "crypto_spot"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop", "oco"],
    rateLimit: { perSecond: 10 }, implemented: false,
    docsUrl: "https://api.tradestation.com/docs/",
    summary: "OAuth 2.0 with refresh tokens wired; signed trading pending first-class rollout.",
  },
  {
    brokerId: "ibkr", authentication: "sdk",
    supportsTokenRotation: true, supportsIpAllowlist: true,
    read: true, marketData: true, historicalData: true, websocket: true,
    trading: false, orderManagement: false, positionSync: true, accountSync: true,
    withdrawalsReadOnly: true,
    assetClasses: ["stocks", "options", "futures", "forex", "cfd", "commodities", "indices"],
    orderTypes: [...STANDARD_ORDERS, "trailing_stop", "oco"],
    rateLimit: { perSecond: 10 }, implemented: false,
    docsUrl: "https://www.interactivebrokers.com/en/trading/ib-api.php",
    summary: "Client Portal Gateway framework wired; signed trading pending first-class rollout.",
  },
];

export function getCapabilities(brokerId: string): ConnectorCapabilities | undefined {
  return CAPABILITIES.find(c => c.brokerId === brokerId);
}

export function allCapabilities(): ConnectorCapabilities[] {
  return CAPABILITIES.slice();
}

/** UI badges — small, glanceable strings for a broker's capability cluster. */
export function capabilityBadges(brokerId: string): { label: string; tone: "on" | "off" | "info" }[] {
  const c = getCapabilities(brokerId);
  if (!c) return [];
  const on = (v: boolean, label: string) => ({ label, tone: v ? ("on" as const) : ("off" as const) });
  return [
    { label: c.authentication.toUpperCase(), tone: "info" },
    on(c.read, "READ"),
    on(c.trading, "TRADE"),
    on(c.marketData, "MKT DATA"),
    on(c.historicalData, "HIST"),
    on(c.websocket, "WEBSOCKET"),
    on(c.orderManagement, "ORDER MGMT"),
    on(c.positionSync, "POS SYNC"),
    on(c.accountSync, "ACCT SYNC"),
  ];
}
