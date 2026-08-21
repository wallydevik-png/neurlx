import { describe, it, expect } from "vitest";
import {
  StageRecorder, assessCoverage, stageForReason, type SymbolStage,
} from "./symbolTelemetry";

const stages = (...s: Array<[string, SymbolStage["stage"]]>): SymbolStage[] =>
  s.map(([symbol, stage]) => ({ symbol, stage }));

describe("per-symbol market-data telemetry", () => {
  it("records the stage each symbol actually reached", () => {
    const r = new StageRecorder();
    r.record("BTC-USD", "requested");
    r.record("BTC-USD", "completed");
    r.record("US30", "rate_limited", "429");
    r.record("FRA40", "deferred", "cycle_budget");
    expect(r.counts()).toMatchObject({ completed: 1, rate_limited: 1, deferred: 1 });
    expect(r.summary()).toContain("US30:rate_limited(429)");
  });

  it("does not call a partial outage a universe-wide failure", () => {
    const v = assessCoverage(stages(
      ["A", "completed"], ["B", "timeout"], ["C", "rate_limited"],
    ));
    expect(v.completed).toBe(1);
    expect(v.dataFailures).toBe(2);
    expect(v.globalFailure).toBe(false);
  });

  it("does not blame the provider when the cycle simply ran out of budget", () => {
    const v = assessCoverage(stages(
      ["A", "deferred"], ["B", "deferred"], ["C", "deferred"],
    ));
    expect(v.deferred).toBe(3);
    expect(v.dataFailures).toBe(0);
    expect(v.globalFailure).toBe(false);
  });

  it("asserts a global failure only when every asked symbol failed on data", () => {
    const v = assessCoverage(stages(
      ["A", "timeout"], ["B", "rate_limited"], ["C", "unavailable"], ["D", "deferred"],
    ));
    expect(v.completed).toBe(0);
    expect(v.globalFailure).toBe(true);
  });

  it("maps infrastructure reasons to stages, never to a direction", () => {
    expect(stageForReason("rate_limited")).toBe("rate_limited");
    expect(stageForReason("provider_timeout")).toBe("timeout");
    expect(stageForReason("queue_timeout")).toBe("saturated");
    expect(stageForReason("aborted")).toBe("deferred");
    expect(stageForReason("connection_error")).toBe("unavailable");
  });
});
