import { describe, expect, it } from "vitest";
import { buildTradeRequest, sanitizeOrderPrices } from "@/lib/connectors/mt5.server";
 
describe("sanitizeOrderPrices", () => {
  it("rounds levels to the symbol digit grid", () => {
    const r = sanitizeOrderPrices("ORDER_TYPE_BUY", { stopLoss: 1.234567891, takeProfit: 1.35555555 },
      { bid: 1.29998, ask: 1.30002, digits: 5 });
    expect(r.stopLoss).toBe(1.23457);
    expect(r.takeProfit).toBe(1.35556);
  });
 
  it("falls back to market when a buy limit sits above the ask", () => {
    const r = sanitizeOrderPrices("ORDER_TYPE_BUY_LIMIT", { limitPrice: 1.31 },
      { bid: 1.29998, ask: 1.30002, digits: 5 });
    expect(r.actionType).toBe("ORDER_TYPE_BUY");
    expect(r.openPrice).toBeUndefined();
  });
 
  it("keeps a valid sell limit above the bid", () => {
    const r = sanitizeOrderPrices("ORDER_TYPE_SELL_LIMIT", { limitPrice: 1.305 },
      { bid: 1.29998, ask: 1.30002, digits: 5 });
    expect(r.actionType).toBe("ORDER_TYPE_SELL_LIMIT");
    expect(r.openPrice).toBe(1.305);
  });
 
  it("drops a stop-loss placed on the wrong side of a buy", () => {
    const r = sanitizeOrderPrices("ORDER_TYPE_BUY", { stopLoss: 1.4, takeProfit: 1.4 },
      { bid: 1.29998, ask: 1.30002, digits: 5 });
    expect(r.stopLoss).toBeUndefined();
    expect(r.takeProfit).toBe(1.4);
  });
 
  it("downgrades a sell limit below the bid to a market sell", () => {
    const body = buildTradeRequest(
      { symbol: "NEAR-USD", side: "sell", orderType: "limit", qty: 6.5, limitPrice: 1.4, stopLoss: 1.6, takeProfit: 1.2 } as never,
      "NEARUSD", { bid: 1.547, ask: 1.548, digits: 3 },
    );
    expect(body.actionType).toBe("ORDER_TYPE_SELL");
    expect(body.openPrice).toBeUndefined();
    expect(body.symbol).toBe("NEARUSD");
  });
 
  it("widens a stop-loss that's on the correct side but inside the broker's minimum stop distance, instead of dropping it", () => {
    // Buy at ~1.30002 (ask), broker requires stops at least 0.001 away.
    // A stop at 1.2999 is on the correct side (below price) but only 0.00012
    // away — too close. Previously this was silently dropped, leaving the
    // order with no stop-loss at all; it should now be pushed out to the
    // minimum distance instead.
    const r = sanitizeOrderPrices("ORDER_TYPE_BUY", { stopLoss: 1.2999 },
      { bid: 1.29998, ask: 1.30002, digits: 5, minDistance: 0.001 });
    expect(r.stopLoss).toBeDefined();
    expect(r.stopLoss).toBeCloseTo(1.29902, 5);
    expect(r.notes.some(n => n.includes("widened"))).toBe(true);
  });
 
  it("still drops a stop-loss genuinely on the wrong side even with a minimum distance configured", () => {
    const r = sanitizeOrderPrices("ORDER_TYPE_BUY", { stopLoss: 1.4 },
      { bid: 1.29998, ask: 1.30002, digits: 5, minDistance: 0.001 });
    expect(r.stopLoss).toBeUndefined();
    expect(r.notes.some(n => n.includes("wrong side"))).toBe(true);
  });
 
  it("leaves a comfortably-placed stop untouched when it already clears the minimum distance", () => {
    const r = sanitizeOrderPrices("ORDER_TYPE_BUY", { stopLoss: 1.28 },
      { bid: 1.29998, ask: 1.30002, digits: 5, minDistance: 0.001 });
    expect(r.stopLoss).toBe(1.28);
    expect(r.notes.length).toBe(0);
  });
});
