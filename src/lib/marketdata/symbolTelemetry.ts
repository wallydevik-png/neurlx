// Per-symbol market-data stage telemetry.
//
// The engine used to record ONE global note ("market_data_unavailable_for_
// universe") whenever the committee returned nothing, which hid the real
// stage: a symbol that was never started (cycle budget) looked identical to a
// symbol whose broker genuinely has no history. Every symbol now carries its
// own stage so the dashboard can tell those apart, and so the global
// failure state can be asserted from measured coverage instead of guessed.

import type { HistoryFailureReason } from "./historyGate.server";

export type MarketDataStage =
  | "requested"
  | "started"
  | "completed"
  | "too_few_candles"
  | "timeout"
  | "rate_limited"
  | "saturated"
  | "error"
  | "unavailable"
  | "deferred";

export interface SymbolStage {
  symbol: string;
  stage: MarketDataStage;
  detail?: string;
}

/** Maps an infrastructure failure reason onto a per-symbol stage. Never maps
 *  to a directional (bullish/bearish/wait) opinion. */
export function stageForReason(reason: HistoryFailureReason): MarketDataStage {
  switch (reason) {
    case "rate_limited": return "rate_limited";
    case "provider_timeout": return "timeout";
    case "queue_timeout":
    case "saturated": return "saturated";
    case "aborted": return "deferred";
    case "too_few_candles": return "too_few_candles";
    case "provider_unavailable":
    case "connection_error":
    case "provisioning_error":
    case "symbol_unavailable": return "unavailable";
    default: return "error";
  }
}

export class StageRecorder {
  private stages = new Map<string, SymbolStage>();

  record(symbol: string, stage: MarketDataStage, detail?: string) {
    this.stages.set(symbol, { symbol, stage, ...(detail ? { detail } : {}) });
  }

  all(): SymbolStage[] {
    return [...this.stages.values()];
  }

  counts(): Record<MarketDataStage, number> {
    const out = {} as Record<MarketDataStage, number>;
    for (const s of this.stages.values()) out[s.stage] = (out[s.stage] ?? 0) + 1;
    return out;
  }

  /** Compact `SYMBOL:stage` telemetry line. */
  summary(limit = 12): string {
    return this.all().slice(0, limit)
      .map(s => `${s.symbol}:${s.stage}${s.detail ? `(${s.detail})` : ""}`)
      .join(",");
  }
}

export interface CoverageVerdict {
  attempted: number;
  completed: number;
  /** Symbols that failed for a data-plane reason (not budget/abort). */
  dataFailures: number;
  /** Symbols never started because the cycle ran out of budget. */
  deferred: number;
  coverage: number; // completed / attempted, 0..1
  globalFailure: boolean;
}

/**
 * The global "market data unavailable for the whole universe" state is only
 * legitimate when usable coverage is at or below the intentional threshold AND
 * the misses are genuine data-plane failures rather than budget deferrals.
 */
export const GLOBAL_FAILURE_COVERAGE_THRESHOLD = 0.2;

export function assessCoverage(
  stages: SymbolStage[],
  threshold = GLOBAL_FAILURE_COVERAGE_THRESHOLD,
): CoverageVerdict {
  const attempted = stages.length;
  const completed = stages.filter(s => s.stage === "completed").length;
  const deferred = stages.filter(s => s.stage === "deferred").length;
  const dataFailures = attempted - completed - deferred;
  const started = attempted - deferred;
  const coverage = started > 0 ? completed / started : 0;
  return {
    attempted, completed, dataFailures, deferred, coverage,
    // Every symbol we actually asked about failed on the data plane.
    globalFailure: started > 0 && completed === 0 && dataFailures === started
      && coverage <= threshold,
  };
}
