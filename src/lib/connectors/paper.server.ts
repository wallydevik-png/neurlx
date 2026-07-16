// Paper (simulated) connector. Deterministic-ish synthetic price feed with
// fee + slippage modeling. Server-only.
import type {
  Balance, ConnectorPosition, HistoryEntry, PlaceOrderInput, PlaceOrderResult,
  Quote, TradingConnector,
} from "./types";

const BASE_PRICES: Record<string, number> = {
  "BTC-USD": 68000,
  "ETH-USD": 3500,
  "SOL-USD": 175,
  "AAPL": 225,
  "TSLA": 240,
  "NVDA": 135,
};

function syntheticPrice(symbol: string): number {
  const base = BASE_PRICES[symbol] ?? 100;
  // Slow sine drift + small random jitter — deterministic per minute.
  const t = Date.now() / 60_000;
  const drift = Math.sin(t / 30) * 0.02;
  const jitter = (Math.sin(t * 7.13 + symbol.length) + 1) / 2 * 0.01;
  return +(base * (1 + drift + jitter)).toFixed(2);
}

export function createPaperConnector(): TradingConnector {
  const FEE_BPS = 10;      // 0.10%
  const SLIPPAGE_BPS = 5;  // 0.05% market impact

  return {
    id: "paper",
    displayName: "Paper Trading",
    async verify() { return { ok: true, message: "Paper account active" }; },
    async getBalances(): Promise<Balance[]> {
      return [{ currency: "USD", total: 100000, available: 100000 }];
    },
    async getQuote(symbol): Promise<Quote> {
      const mid = syntheticPrice(symbol);
      const spread = mid * 0.0002;
      return { symbol, mid, bid: mid - spread, ask: mid + spread, ts: Date.now() };
    },
    async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
      const q = await this.getQuote(input.symbol);
      const ref = input.side === "buy" ? q.ask : q.bid;
      const slipDir = input.side === "buy" ? 1 : -1;
      const filledPrice = +(ref * (1 + slipDir * SLIPPAGE_BPS / 10_000)).toFixed(4);
      const notional = filledPrice * input.qty;
      const fees = +(notional * FEE_BPS / 10_000).toFixed(4);
      return {
        externalOrderId: `paper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        status: "filled",
        filledPrice,
        fees,
        slippageBps: SLIPPAGE_BPS,
      };
    },
    async cancelOrder() { return { ok: true }; },
    async getPositions(): Promise<ConnectorPosition[]> { return []; },
    async getHistory(): Promise<HistoryEntry[]> { return []; },
  };
}
