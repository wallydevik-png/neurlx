import { describe, it, expect } from "vitest";
import { multiTimeframeConfirmation } from "@/lib/execution/entryAI";
describe("mtf", () => { it("1 opposed passes", () => {
  const r = multiTimeframeConfirmation({ "1d":"bullish","4h":"bearish","1h":"bearish","15m":"bearish","5m":"bearish" } as any, "sell");
  expect([r.aligned, r.opposed, r.confirmed]).toEqual([4,1,true]);
}); });
