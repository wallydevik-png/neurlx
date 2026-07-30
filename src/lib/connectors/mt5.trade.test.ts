import { describe, expect, it } from "vitest";
import { buildTradeRequest, resolveTradeAction, sanitizeClientId, MT_CLIENT_ID_PATTERN, MT_ACTIONS } from "./mt5.server";
import type { PlaceOrderInput } from "./types";

const base: PlaceOrderInput = {
  symbol: "BTC-USD", side: "buy", qty: 0.1, orderType: "market",
};

describe("resolveTradeAction", () => {
  it("maps buy/sell market", () => {
    expect(resolveTradeAction("buy", "market")).toBe(MT_ACTIONS.buy_market);
    expect(resolveTradeAction("sell", "market")).toBe(MT_ACTIONS.sell_market);
  });
  it("maps limit and stop orders", () => {
    expect(resolveTradeAction("buy", "limit")).toBe(MT_ACTIONS.buy_limit);
    expect(resolveTradeAction("sell", "stop_loss_limit")).toBe(MT_ACTIONS.sell_limit);
    expect(resolveTradeAction("buy", "stop")).toBe(MT_ACTIONS.buy_stop);
  });
  it("normalizes committee wording", () => {
    expect(resolveTradeAction("LONG", undefined)).toBe(MT_ACTIONS.buy_market);
    expect(resolveTradeAction("Short", "MARKET")).toBe(MT_ACTIONS.sell_market);
    expect(resolveTradeAction(undefined, "buy_limit")).toBe(MT_ACTIONS.buy_limit);
  });
  it("throws instead of returning undefined", () => {
    expect(() => resolveTradeAction("wait", "market")).toThrow(/Unknown trade direction/);
  });
});

describe("buildTradeRequest", () => {
  it("builds a BUY market order", () => {
    expect(buildTradeRequest(base, "BTCUSD")).toEqual({
      actionType: "ORDER_TYPE_BUY", symbol: "BTCUSD", volume: 0.1,
    });
  });
  it("builds a SELL market order with stop loss", () => {
    expect(buildTradeRequest({ ...base, side: "sell", stopPrice: 71000 }, "BTCUSD")).toEqual({
      actionType: "ORDER_TYPE_SELL", symbol: "BTCUSD", volume: 0.1, stopLoss: 71000,
    });
  });
  it("requires openPrice on pending orders", () => {
    expect(() => buildTradeRequest({ ...base, orderType: "limit" }, "BTCUSD"))
      .toThrow(/positive openPrice/);
    expect(buildTradeRequest({ ...base, orderType: "limit", limitPrice: 60000 }, "BTCUSD"))
      .toMatchObject({ actionType: "ORDER_TYPE_BUY_LIMIT", openPrice: 60000 });
  });
  it("rejects non-positive volume", () => {
    expect(() => buildTradeRequest({ ...base, qty: 0 }, "BTCUSD")).toThrow(/Invalid MT volume/);
  });
  it("never emits an undefined action", () => {
    const body = buildTradeRequest(base, "BTCUSD");
    expect(body.actionType).toBeDefined();
  });
  it("sanitizes clientId to MetaApi's pattern", () => {
    const body = buildTradeRequest(
      { ...base, clientOrderId: "hlx_d7c4be3c525a4a7dae692d48c551" }, "BTCUSD",
    );
    expect(String(body.clientId)).toMatch(MT_CLIENT_ID_PATTERN);
    expect(String(body.clientId).length).toBeLessThanOrEqual(24);
  });
  it("omits clientId when nothing valid remains", () => {
    expect(buildTradeRequest({ ...base, clientOrderId: "!!!---" }, "BTCUSD"))
      .not.toHaveProperty("clientId");
    expect(buildTradeRequest(base, "BTCUSD")).not.toHaveProperty("clientId");
  });
});

describe("sanitizeClientId", () => {
  it("keeps valid ids untouched", () => {
    expect(sanitizeClientId("abc_123")).toBe("abc_123");
  });
  it("strips separators and truncates", () => {
    expect(sanitizeClientId("hlx-d7c4be3c-525a-4a7d-ae69-2d48c551")).toBe("hlxd7c4be3c525a4a7dae692d");
  });
  it("returns undefined for empty input", () => {
    expect(sanitizeClientId(undefined)).toBeUndefined();
    expect(sanitizeClientId("###")).toBeUndefined();
  });
});
