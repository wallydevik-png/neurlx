// Modular connector interface. Any new exchange/broker implements this
// and registers itself in ./registry.ts — the trading engine consumes it
// abstractly, so adding a real exchange later requires no engine changes.

export type Side = "buy" | "sell";
export type OrderType =
  | "market"
  | "limit"
  | "stop_loss_limit"
  | "take_profit_limit";
export type OrderStatus =
  | "pending"
  | "working"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface Balance {
  currency: string;
  total: number;
  available: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  ts: number;
}

export interface PlaceOrderInput {
  symbol: string;
  side: Side;
  qty: number;
  orderType: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  /** Idempotency key. If supplied, the connector MUST use it as clientOrderId. */
  clientOrderId?: string;
}

export interface PlaceOrderResult {
  externalOrderId: string;
  clientOrderId?: string;
  status: OrderStatus;
  filledPrice?: number;
  filledQty?: number;
  fees: number;
  feeCurrency?: string;
  slippageBps: number;
  latencyMs?: number;
  raw?: unknown;
}

export interface ConnectorPosition {
  symbol: string;
  qty: number;
  avgEntry: number;
}

export interface HistoryEntry {
  externalOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  fees: number;
  ts: number;
}

export interface OrderStatusResult {
  externalOrderId: string;
  clientOrderId?: string;
  status: OrderStatus;
  filledQty: number;
  cumulativeQuoteQty: number;
  avgPrice: number;
  fees: number;
  feeCurrency?: string;
  updatedAt: number;
}

export interface ApiPermissionSnapshot {
  ipRestrict?: boolean;
  enableReading: boolean;
  enableSpotAndMarginTrading: boolean;
  enableWithdrawals: boolean;
  enableInternalTransfer?: boolean;
  enableMargin?: boolean;
  enableFutures?: boolean;
  tradingAuthorityExpirationTime?: number | null;
  raw?: unknown;
}

export interface ConnectionHealth {
  ok: boolean;
  pingLatencyMs: number | null;
  clockSkewMs: number | null;
  message?: string;
}

export interface SymbolFilter {
  minQty: number;
  stepSize: number;
  tickSize: number;
  minNotional: number;
}

/** Broker-side account state used by the live desk + margin pre-check. */
export interface AccountSummary {
  currency: string;
  balance: number;
  equity: number;
  freeMargin: number;
  usedMargin: number;
  marginLevel: number | null;
  leverage?: number | null;
}

/** Full open-position detail as reported by the broker. */
export interface RichPosition {
  ticket: string;
  symbol: string;
  side: "long" | "short";
  volume: number;
  openPrice: number;
  currentPrice: number | null;
  profit: number;
  swap: number;
  commission: number;
  usedMargin: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: string;
  raw?: unknown;
}

/** A completed broker trade (deal/position closed). */
export interface ClosedDeal {
  ticket: string;
  positionTicket: string | null;
  symbol: string;
  side: "long" | "short";
  volume: number;
  entryPrice: number | null;
  exitPrice: number | null;
  grossProfit: number;
  commission: number;
  swap: number;
  netProfit: number;
  openedAt: string | null;
  closedAt: string;
  comment?: string | null;
}

export interface MarginEstimate {
  /** Margin required for the requested volume, in account currency. */
  margin: number;
  freeMargin: number;
  sufficient: boolean;
}


export interface TradingConnector {
  id: string;
  displayName: string;
  verify(): Promise<{ ok: boolean; message?: string }>;
  getBalances(): Promise<Balance[]>;
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  cancelOrder(
    externalOrderId: string,
    symbol?: string,
  ): Promise<{ ok: boolean }>;
  getPositions(): Promise<ConnectorPosition[]>;
  getHistory(limit?: number): Promise<HistoryEntry[]>;
  /** Optional real-exchange capabilities used by preTradeCheck + reconciler. */
  checkHealth?(): Promise<ConnectionHealth>;
  getApiPermissions?(): Promise<ApiPermissionSnapshot>;
  getSymbolFilter?(symbol: string): Promise<SymbolFilter | null>;
  getOrderStatus?(
    externalOrderId: string,
    symbol: string,
    clientOrderId?: string,
  ): Promise<OrderStatusResult>;
  /** Live-desk extensions (implemented by MetaTrader today). */
  getAccountSummary?(): Promise<AccountSummary | null>;
  getRichPositions?(): Promise<RichPosition[]>;
  getClosedDeals?(sinceMs?: number): Promise<ClosedDeal[]>;
  estimateMargin?(
    symbol: string,
    side: Side,
    volume: number,
    price?: number,
  ): Promise<MarginEstimate | null>;
  supportsRealExecution?: boolean;
  /** Optional: connector can also serve as a real market-data source
   *  (candle history + broker symbol list) for signal generation. */
  getCandles?(symbol: string, interval: ConnectorInterval, limit: number): Promise<ConnectorCandle[]>;
  listSymbols?(): Promise<string[]>;
}


export interface ConnectorDescriptor {
  id: string;
  displayName: string;
  authType: "api_key" | "oauth" | "paper";
  supportsRealTrading: boolean;
  description: string;
  credentialFields?: { key: string; label: string; secret?: boolean; placeholder?: string }[];
}

export type CredentialPayload = Record<string, string>;

/** A single OHLCV bar, used by connectors that can also supply price history. */
export interface ConnectorCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ConnectorInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

/** Optional capability: connectors that can supply real historical candles
 *  for signal generation (currently: MetaTrader via MetaApi). If a connector
 *  does not implement this, the market-data layer falls back to whatever
 *  other providers are registered (and ultimately synthetic data, flagged as
 *  such — never silently). */
export interface MarketDataCapableConnector {
  getCandles(symbol: string, interval: ConnectorInterval, limit: number): Promise<ConnectorCandle[]>;
  /** The broker's full tradable instrument list, in NeurlX symbol form where
   *  resolvable (e.g. "EUR-USD", "BTC-USD"), used to scan beyond the fixed
   *  hardcoded universe. */
  listSymbols(): Promise<string[]>;
}
