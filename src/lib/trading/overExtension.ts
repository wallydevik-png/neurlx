// Over-extension guard (Bollinger %B).
//
// The guard must always look at the side of the band the trade is heading
// INTO: a BUY is over-extended near the UPPER band (%B → 1), a SELL is
// over-extended near the LOWER band (%B → 0). A low %B is therefore only a
// rejection for sells, never a universal one.
export interface OverExtension {
  extended: boolean;
  detail: string;
}

export const OVER_EXTENSION_UPPER = 0.97;
export const OVER_EXTENSION_LOWER = 0.03;

export function evaluateOverExtension(
  percentB: number | null | undefined,
  side: "buy" | "sell",
): OverExtension {
  if (percentB == null || !Number.isFinite(percentB)) {
    return { extended: false, detail: "bands unavailable" };
  }
  const pct = `${(percentB * 100).toFixed(0)}%`;
  if (side === "buy") {
    const extended = percentB > OVER_EXTENSION_UPPER;
    return {
      extended,
      detail: extended
        ? `BUY blocked — %B ${pct}, price pinned to the UPPER band (chasing the top)`
        : `%B ${pct} — BUY has room below the upper band`,
    };
  }
  const extended = percentB < OVER_EXTENSION_LOWER;
  return {
    extended,
    detail: extended
      ? `SELL blocked — %B ${pct}, price pinned to the LOWER band (chasing the bottom)`
      : `%B ${pct} — SELL has room above the lower band`,
  };
}
