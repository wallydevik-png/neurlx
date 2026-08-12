import { describe, expect, it } from "vitest";
import { evaluateOverExtension } from "./overExtension";

describe("over-extension guard direction", () => {
  it("does NOT block a sell-side low %B for a buy", () => {
    expect(evaluateOverExtension(0.02, "buy").extended).toBe(false);
  });
  it("blocks a buy pinned to the upper band", () => {
    const r = evaluateOverExtension(0.99, "buy");
    expect(r.extended).toBe(true);
    expect(r.detail).toContain("UPPER");
  });
  it("blocks a sell pinned to the lower band", () => {
    const r = evaluateOverExtension(0.02, "sell");
    expect(r.extended).toBe(true);
    expect(r.detail).toContain("LOWER");
  });
  it("does not block a sell near the upper band", () => {
    expect(evaluateOverExtension(0.99, "sell").extended).toBe(false);
  });
  it("passes through when bands are unavailable", () => {
    expect(evaluateOverExtension(null, "buy")).toEqual({ extended: false, detail: "bands unavailable" });
  });
  it("names the side in the log detail", () => {
    expect(evaluateOverExtension(0.5, "sell").detail).toContain("SELL");
    expect(evaluateOverExtension(0.5, "buy").detail).toContain("BUY");
  });
});
