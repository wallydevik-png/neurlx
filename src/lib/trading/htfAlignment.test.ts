import { describe, expect, it } from "vitest";
import { isHtfAligned, tallyHtf, classifyHtf, htfTelemetry } from "./htfAlignment";

describe("HTF tally", () => {
  it("counts BUY + bullish as agreement and BUY + bearish as contradiction", () => {
    const t = tallyHtf({ d1: "bullish", h4: "bearish", h1: "bullish" }, "bullish");
    expect(t).toMatchObject({ agree: 2, contradict: 1, unknown: 0, unavailable: 0 });
  });

  it("counts SELL + bearish as agreement and SELL + bullish as contradiction", () => {
    const t = tallyHtf({ d1: "bearish", h4: "bullish", h1: "bearish" }, "bearish");
    expect(t).toMatchObject({ agree: 2, contradict: 1 });
  });

  it("never treats unknown as bullish or bearish", () => {
    const t = tallyHtf({ d1: "unknown", h4: "bullish", h1: "unknown" }, "bullish");
    expect(t).toMatchObject({ agree: 1, contradict: 0, unknown: 2 });
  });

  it("never treats unavailable as a contradiction", () => {
    const t = tallyHtf({ d1: "unavailable", h4: "unavailable", h1: "unavailable" }, "bearish");
    expect(t).toMatchObject({ agree: 0, contradict: 0, unavailable: 3 });
  });
});

describe("HTF classification", () => {
  it("classifies 1 bullish + 2 unknown as insufficient data, not contradiction", () => {
    expect(classifyHtf({ d1: "unknown", h4: "bullish", h1: "unknown" }, "bullish"))
      .toBe("insufficient_data");
  });

  it("classifies 1 bearish + 2 unknown against a BUY as partial contradiction", () => {
    const bias = { d1: "unknown", h4: "bearish", h1: "unknown" };
    expect(tallyHtf(bias, "bullish")).toMatchObject({ agree: 0, contradict: 1, unknown: 2 });
    expect(classifyHtf(bias, "bullish")).toBe("partial_contradiction");
  });

  it("classifies all-unavailable as unavailable", () => {
    expect(classifyHtf({ d1: "unavailable", h4: "unavailable", h1: "unavailable" }, "bullish"))
      .toBe("unavailable");
  });

  it("classifies two opposing timeframes as a full contradiction", () => {
    expect(classifyHtf({ d1: "bearish", h4: "bearish", h1: "bullish" }, "bullish"))
      .toBe("full_contradiction");
  });

  it("classifies an aligned 2/3 majority as aligned for both directions", () => {
    expect(classifyHtf({ d1: "bullish", h4: "bullish", h1: "bearish" }, "bullish")).toBe("aligned");
    expect(classifyHtf({ d1: "bearish", h4: "bearish", h1: "bullish" }, "bearish")).toBe("aligned");
  });
});

describe("HTF gate", () => {
  it("fails closed when confirmation is missing rather than unknown-as-agreement", () => {
    expect(isHtfAligned({ d1: "unknown", h4: "bullish", h1: "unknown" }, "bullish")).toBe(false);
    expect(isHtfAligned({ d1: "unavailable", h4: "unavailable", h1: "bearish" }, "bearish")).toBe(false);
  });

  it("is directionally symmetric", () => {
    expect(isHtfAligned({ d1: "bullish", h4: "bullish", h1: "neutral" }, "bullish")).toBe(true);
    expect(isHtfAligned({ d1: "bearish", h4: "bearish", h1: "neutral" }, "bearish")).toBe(true);
  });

  it("emits structured telemetry instead of an N/3 ratio", () => {
    expect(htfTelemetry({ d1: "unknown", h4: "bearish", h1: "unknown" }, "buy"))
      .toContain("agree=0 contradict=1 neutral=0 unknown=2 unavailable=0");
  });
});
