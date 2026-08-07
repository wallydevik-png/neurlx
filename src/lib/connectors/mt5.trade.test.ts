import { describe, expect, it } from "vitest";
import {
  buildTradeRequest, resolveTradeAction, sanitizeClientId, splitPair, candidatesFor,
  MT_CLIENT_ID_PATTERN, MT_CLIENT_ID_MAX_LEN, MT_ACTIONS, normalizeVolume, InvalidVolumeError,
  marketDataBaseFor,
} from "./mt5.server";
import type { PlaceOrderInput } from "./types";

const base: PlaceOrderInput = {
  symbol: "BTC-USD", side: "buy", qty: 0.1, orderType: "market",
};

describe("MetaApi routing", () => {
  it("routes historical candles to the dedicated market-data service", () => {
    expect(marketDataBaseFor("new-york"))
      .toBe("https://mt-market-data-client-api-v1.new-york.agiliumtrade.ai");
  });
});

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
    expect(buildTradeRequest({ ...base, side: "sell", stopLoss: 71000 }, "BTCUSD")).toEqual({
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
  it("emits a MetaApi-compliant clientId", () => {
    const body = buildTradeRequest(
      { ...base, clientOrderId: "hlx_23e5a02f91ba44c1948b" }, "BTCUSD",
    );
    expect(String(body.clientId)).toMatch(MT_CLIENT_ID_PATTERN);
    expect(String(body.clientId).length).toBeLessThanOrEqual(MT_CLIENT_ID_MAX_LEN);
  });
  it("omits clientId when nothing valid remains", () => {
    expect(buildTradeRequest({ ...base, clientOrderId: "!!!---" }, "BTCUSD"))
      .not.toHaveProperty("clientId");
    expect(buildTradeRequest(base, "BTCUSD")).not.toHaveProperty("clientId");
  });
});

describe("sanitizeClientId", () => {
  it("keeps already-compliant three-part ids", () => {
    expect(sanitizeClientId("RF_EURUSD_GjCy5lk")).toBe("RF_EURUSD_GjCy5lk");
  });
  it("rewrites internal ids into strategy_position_order form", () => {
    const id = sanitizeClientId("hlx_23e5a02f91ba44c1948b");
    expect(id).toMatch(MT_CLIENT_ID_PATTERN);
    expect((id ?? "").length).toBeLessThanOrEqual(MT_CLIENT_ID_MAX_LEN);
  });
  it("returns undefined for empty input", () => {
    expect(sanitizeClientId(undefined)).toBeUndefined();
    expect(sanitizeClientId("###")).toBeUndefined();
  });
});

describe("symbol aliasing", () => {
  it("splits AI pairs", () => {
    expect(splitPair("CRV-USD")).toEqual({ base: "CRV", quote: "USD" });
    expect(splitPair("EUR/USD")).toEqual({ base: "EUR", quote: "USD" });
    expect(splitPair("BTCUSDT")).toEqual({ base: "BTC", quote: "USDT" });
  });
  it("offers USD/USDT/USDC aliases for crypto", () => {
    const c = candidatesFor("LTC-USD");
    expect(c).toContain("LTCUSD");
    expect(c).toContain("LTCUSDT");
    expect(c).toContain("LTCUSDC");
  });
  it("maps forex pairs to broker form", () => {
    expect(candidatesFor("EUR/USD")).toContain("EURUSD");
  });
});

describe("normalizeVolume", () => {
  const spec = { volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01 };
  it("rounds to the broker step", () => {
    expect(normalizeVolume(0.0345, spec).volume).toBe(0.03);
    expect(normalizeVolume(1.007, spec).volume).toBe(1.01);
  });
  it("raises sub-minimum sizes to the minimum lot", () => {
    const r = normalizeVolume(0.0001, spec);
    expect(r.volume).toBe(0.01);
    expect(r.note).toMatch(/minimum lot/);
  });
  it("clamps to the broker maximum", () => {
    const r = normalizeVolume(5000, spec);
    expect(r.volume).toBe(100);
    expect(r.note).toMatch(/maximum lot/);
  });
  it("honours coarse steps like 0.1", () => {
    expect(normalizeVolume(0.44, { volumeMin: 0.1, volumeMax: 50, volumeStep: 0.1 }).volume).toBe(0.4);
  });
  it("falls back to sane defaults when the spec is empty", () => {
    expect(normalizeVolume(0.234, {}).volume).toBe(0.23);
  });
  it("throws InvalidVolumeError on non-positive input", () => {
    expect(() => normalizeVolume(0, spec)).toThrow(InvalidVolumeError);
  });
});
