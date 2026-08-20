import { describe, expect, it } from "vitest";
import { checkEventWindow } from "./eventWindow";

// 2026-01-06 is a Tuesday, 2026-01-03 a Saturday.
describe("event window — asset-class awareness", () => {
  it("blocks forex during the US macro release window", () => {
    const w = checkEventWindow(new Date("2026-01-06T12:35:00Z"), "EURUSD");
    expect(w.active).toBe(true);
    expect(w.assetClass).toBe("forex");
  });

  it("does not block crypto 15 minutes after the US macro print", () => {
    const w = checkEventWindow(new Date("2026-01-06T12:45:00Z"), "BTC-USD");
    expect(w.active).toBe(false);
    expect(w.assetClass).toBe("crypto");
  });

  it("still stands crypto down in the minutes around the print", () => {
    expect(checkEventWindow(new Date("2026-01-06T12:32:00Z"), "ETH-USD").active).toBe(true);
  });

  it("ignores non-crypto-relevant releases for crypto", () => {
    expect(checkEventWindow(new Date("2026-01-06T14:00:00Z"), "SOL-USD").active).toBe(false);
    expect(checkEventWindow(new Date("2026-01-06T14:00:00Z"), "XAUUSD").active).toBe(true);
  });

  it("blocks the weekend for forex but not for crypto", () => {
    expect(checkEventWindow(new Date("2026-01-03T12:00:00Z"), "EURUSD").active).toBe(true);
    expect(checkEventWindow(new Date("2026-01-03T12:00:00Z"), "DOGE-USD").active).toBe(false);
  });

  it("blocks daily rollover for every asset class", () => {
    expect(checkEventWindow(new Date("2026-01-06T23:50:00Z"), "BTC-USD").active).toBe(true);
    expect(checkEventWindow(new Date("2026-01-06T23:50:00Z"), "EURUSD").active).toBe(true);
  });

  it("allows a quiet weekday hour", () => {
    expect(checkEventWindow(new Date("2026-01-06T16:10:00Z"), "EURUSD").active).toBe(false);
    expect(checkEventWindow(new Date("2026-01-06T16:10:00Z"), "BTC-USD").active).toBe(false);
  });

  it("keeps the strict calendar when no symbol is supplied", () => {
    expect(checkEventWindow(new Date("2026-01-06T12:35:00Z")).active).toBe(true);
  });
});
