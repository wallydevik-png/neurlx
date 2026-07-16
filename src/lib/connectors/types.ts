// Modular connector interface. Any new exchange/broker implements this
// and registers itself in ./registry.ts — the trading engine consumes it
// abstractly, so adding a real exchange later requires no engine changes.

export type Side = "buy" | "sell";
export type OrderType = "market" | "limit";
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected";

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
}

export interface PlaceOrderResult {
  externalOrderId: string;
  status: OrderStatus;
  filledPrice?: number;
  fees: number;
  slippageBps: number;
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

export interface TradingConnector {
  id: string;
  displayName: string;
  verify(): Promise<{ ok: boolean; message?: string }>;
  getBalances(): Promise<Balance[]>;
  getQuote(symbol: string): Promise<Quote>;
  placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult>;
  cancelOrder(externalOrderId: string): Promise<{ ok: boolean }>;
  getPositions(): Promise<ConnectorPosition[]>;
  getHistory(limit?: number): Promise<HistoryEntry[]>;
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
