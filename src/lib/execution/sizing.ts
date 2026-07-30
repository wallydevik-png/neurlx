// Pure position-sizing math shared by the MT5 executor and the risk gate.
// Kept dependency-free so it can be unit tested and imported anywhere.

export interface SizingSpec {
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  contractSize: number;
  /** Margin required for ONE lot, in account currency (broker-calculated). */
  marginPerLot?: number | null;
}

export interface SizingInput {
  equity: number;
  freeMargin: number;
  /** Fraction of equity risked on this trade, e.g. 0.01 for 1%. */
  riskPct: number;
  entryPrice: number;
  stopLoss?: number | null;
  spec: SizingSpec;
  /** Keep this share of free margin untouched (0.2 = never use the last 20%). */
  marginBufferPct?: number;
}

export interface SizingResult {
  volume: number;
  /** Explains how the final volume was reached (logged + shown in the UI). */
  notes: string[];
  /** Set when no valid volume exists — the caller must skip the trade. */
  skipReason?: string;
  riskAmount: number;
  estimatedMargin: number | null;
}

function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf(".");
  return i === -1 ? 0 : Math.min(8, s.length - i - 1);
}

function snap(value: number, spec: SizingSpec): number {
  const step = spec.volumeStep > 0 ? spec.volumeStep : spec.volumeMin || 0.01;
  const min = spec.volumeMin > 0 ? spec.volumeMin : 0.01;
  const d = Math.max(decimalsOf(step), decimalsOf(min));
  return Number((min + Math.floor((value - min) / step + 1e-9) * step).toFixed(d));
}

/**
 * Size a trade from equity, risk %, stop distance and broker lot limits, then
 * cap it so the required margin never exceeds the usable free margin.
 */
export function computePositionSize(input: SizingInput): SizingResult {
  const notes: string[] = [];
  const spec: SizingSpec = {
    volumeMin: Number(input.spec.volumeMin) > 0 ? Number(input.spec.volumeMin) : 0.01,
    volumeMax: Number(input.spec.volumeMax) > 0 ? Number(input.spec.volumeMax) : 100,
    volumeStep: Number(input.spec.volumeStep) > 0 ? Number(input.spec.volumeStep) : 0.01,
    contractSize: Number(input.spec.contractSize) > 0 ? Number(input.spec.contractSize) : 1,
    marginPerLot: input.spec.marginPerLot ?? null,
  };
  const buffer = Math.min(Math.max(input.marginBufferPct ?? 0.2, 0), 0.9);
  const usableMargin = Math.max(0, Number(input.freeMargin) * (1 - buffer));
  const riskAmount = Math.max(0, Number(input.equity) * Math.max(0, input.riskPct));

  const stop = Number(input.stopLoss ?? 0);
  const entry = Number(input.entryPrice);
  let volume: number;

  if (stop > 0 && entry > 0 && Math.abs(entry - stop) > 0) {
    const perLotRisk = Math.abs(entry - stop) * spec.contractSize;
    volume = perLotRisk > 0 ? riskAmount / perLotRisk : spec.volumeMin;
    notes.push(`risk ${riskAmount.toFixed(2)} / stop distance ${Math.abs(entry - stop)}`);
  } else {
    // No stop: fall back to a notional cap of the risked amount x10.
    const perLotNotional = entry * spec.contractSize;
    volume = perLotNotional > 0 ? (riskAmount * 10) / perLotNotional : spec.volumeMin;
    notes.push("no stop loss — sized from notional cap");
  }

  // Margin ceiling.
  const marginPerLot = spec.marginPerLot && spec.marginPerLot > 0 ? spec.marginPerLot : null;
  if (marginPerLot) {
    const maxByMargin = usableMargin / marginPerLot;
    if (volume > maxByMargin) {
      volume = maxByMargin;
      notes.push(`capped by free margin (usable ${usableMargin.toFixed(2)})`);
    }
  }

  if (volume > spec.volumeMax) {
    volume = spec.volumeMax;
    notes.push(`clamped to broker max lot ${spec.volumeMax}`);
  }

  let final = snap(volume, spec);
  if (final < spec.volumeMin) {
    final = spec.volumeMin;
    notes.push(`raised to broker minimum lot ${spec.volumeMin}`);
  }

  const estimatedMargin = marginPerLot ? Number((marginPerLot * final).toFixed(2)) : null;

  if (estimatedMargin !== null && estimatedMargin > usableMargin) {
    return {
      volume: final,
      notes,
      riskAmount,
      estimatedMargin,
      skipReason:
        `insufficient free margin (required ${estimatedMargin.toFixed(2)}, available ${usableMargin.toFixed(2)})`,
    };
  }

  return { volume: final, notes, riskAmount, estimatedMargin };
}
