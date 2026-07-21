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
  supportsRealExecution?: boolean;
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
