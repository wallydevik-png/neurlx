import { describe, expect, it } from "vitest";
import { consensus } from "./committee.server";
import type { AnalystVote } from "./committee.server";

const vote = (
  analyst: AnalystVote["analyst"],
  direction: AnalystVote["direction"],
  confidence: number,
): AnalystVote => ({ analyst, direction, confidence, rationale: "test" });

// Locks in direction-neutral consensus: no code path may quietly reintroduce a
// BUY preference through object-key iteration order.
describe("committee consensus", () => {
  it("resolves a BUY majority to BUY", () => {
    const c = consensus([
      vote("Trend", "buy", 0.7),
      vote("MeanReversion", "buy", 0.6),
      vote("Momentum", "sell", 0.9),
    ]);
    expect(c.direction).toBe("buy");
    expect(c.agreement).toBeCloseTo(2 / 3, 5);
  });

  it("resolves a SELL majority to SELL, even against a higher-confidence BUY", () => {
    const c = consensus([
      vote("Trend", "sell", 0.55),
      vote("MeanReversion", "sell", 0.6),
      vote("Momentum", "buy", 0.99),
    ]);
    expect(c.direction).toBe("sell");
    expect(c.confidence).toBeCloseTo(0.575, 5);
  });

  it("resolves a WAIT majority to WAIT", () => {
    const c = consensus([
      vote("Trend", "wait", 0.5),
      vote("MeanReversion", "wait", 0.5),
      vote("Momentum", "buy", 0.8),
    ]);
    expect(c.direction).toBe("wait");
  });

  it("resolves a BUY/SELL dead heat to WAIT, never to BUY", () => {
    const c = consensus([
      vote("Trend", "buy", 0.7),
      vote("MeanReversion", "sell", 0.7),
    ]);
    expect(c.direction).toBe("wait");
  });

  it("breaks an equal-count BUY/SELL split on summed conviction", () => {
    const buySide = consensus([
      vote("Trend", "buy", 0.8),
      vote("MeanReversion", "sell", 0.6),
    ]);
    expect(buySide.direction).toBe("buy");

    const sellSide = consensus([
      vote("Trend", "buy", 0.6),
      vote("MeanReversion", "sell", 0.8),
    ]);
    expect(sellSide.direction).toBe("sell");
  });

  it("is deterministic on a three-way split and mirrors under direction swap", () => {
    const a = consensus([
      vote("Trend", "buy", 0.6),
      vote("MeanReversion", "sell", 0.9),
      vote("Momentum", "wait", 0.5),
    ]);
    const mirrored = consensus([
      vote("Trend", "sell", 0.6),
      vote("MeanReversion", "buy", 0.9),
      vote("Momentum", "wait", 0.5),
    ]);
    expect(a.direction).toBe("sell");
    expect(mirrored.direction).toBe("buy");
    expect(a.confidence).toBeCloseTo(mirrored.confidence, 5);
  });
});
