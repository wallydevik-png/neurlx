// Provider-agnostic connector stub. Used for brokers that are listed in the
// registry but do not yet have a first-class server connector. It preserves
// NeurlX's uniform TradingConnector interface so the execution engine,
// portfolio manager, risk engine, and mission control can address every
// connected account the same way — a new broker only needs a new module,
// not changes across the platform.
import type {
  Balance, ConnectorPosition, HistoryEntry, PlaceOrderInput, PlaceOrderResult,
  Quote, TradingConnector, ConnectionHealth, ApiPermissionSnapshot,
} from "./types";
import { getBroker } from "./brokerRegistry";

export function createGenericConnector(brokerId: string): TradingConnector {
  const b = getBroker(brokerId);
  const displayName = b?.displayName ?? brokerId;
  const authNotImplemented = () => {
    throw new Error(
      `${displayName} connector is registered but not yet implemented for live calls. ` +
      `NeurlX will present the account as read-only until the official ${b?.authMethod ?? "auth"} integration is wired.`,
    );
  };
  return {
    id: brokerId,
    displayName,
    supportsRealExecution: false,
    async verify() {
      return { ok: true, message: `${displayName} — credentials stored, awaiting first-class connector.` };
    },
    async getBalances(): Promise<Balance[]> { return []; },
    async getQuote(symbol: string): Promise<Quote> {
      return { symbol, bid: 0, ask: 0, mid: 0, ts: Date.now() };
    },
    async placeOrder(_input: PlaceOrderInput): Promise<PlaceOrderResult> {
      return authNotImplemented();
    },
    async cancelOrder() { return { ok: false }; },
    async getPositions(): Promise<ConnectorPosition[]> { return []; },
    async getHistory(): Promise<HistoryEntry[]> { return []; },
    async checkHealth(): Promise<ConnectionHealth> {
      return { ok: true, pingLatencyMs: null, clockSkewMs: null, message: "Stub connector — health reporting will activate with the official integration." };
    },
    async getApiPermissions(): Promise<ApiPermissionSnapshot> {
      return { enableReading: true, enableSpotAndMarginTrading: false, enableWithdrawals: false };
    },
  };
}
