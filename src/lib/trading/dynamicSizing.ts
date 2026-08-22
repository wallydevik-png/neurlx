// Dynamic, risk-aware position sizing.
//
// Replaces the old fixed dollar "max trade size" ceiling. The maximum safe
// notional for a specific opportunity is derived from the account state and
// the opportunity itself:
//
//   risk budget  = equity x dynamic risk-per-trade %   (0.25%..1%, unchanged)
//   conviction   = scales that budget between 40% and 100% (never above)
//   stop distance= converts the risk budget into a quantity
//   balance      = notional can never exceed usable funds
//   exposure     = notional can never exceed remaining portfolio headroom
//
// Every existing safety control (stop-loss requirement, drawdown/capital
// preservation, correlation budget, daily loss limit, kill switch, lifecycle
// and portfolio-manager gates) still applies on top of this — this module only
// answers "how big may this trade be", never "may this trade happen".

export interface DynamicSizingInput {
  /** Account equity in quote currency. */
  equity: number;
  /** Spendable balance / free margin for this order. */
  availableBalance: number;
  /** Probability of profit / consensus confidence, 0..1. */
  confidence: number;
  /** Minimum confidence the account accepts, 0..1 (used to scale conviction). */
  minConfidence?: number;
  /** Dynamic risk fraction of equity for this trade, e.g. 0.005 = 0.5%. */
  riskPct: number;
  entry: number;
  stopLoss?: number | null;
  /** Remaining portfolio exposure headroom in notional terms. */
  exposureHeadroom?: number | null;
  /** Fraction of the available balance kept untouched. Default 10%. */
  balanceBufferPct?: number;
  /** Optional base-asset inventory cap (spot sells can't exceed holdings). */
  maxQty?: number | null;
  /** Decimal places the venue accepts for quantity. Default 8. */
  qtyPrecision?: number;
}

export interface DynamicSizingResult {
  qty: number;
  notional: number;
  maxNotional: number;
  riskBudget: number;
  riskAmount: number;
  stopDistance: number;
  convictionScalar: number;
  binding: string;
  /** Machine-parsable one-liner for cycle telemetry. */
  diagnostics: string;
  skipReason?: string;
}

function floorTo(value: number, precision: number): number {
  const p = Math.pow(10, Math.max(0, Math.min(12, precision)));
  return Math.floor(value * p) / p;
}

/**
 * Conviction scalar: linear from 0.4 at the minimum accepted confidence to 1.0
 * at certainty. Higher-probability setups get a larger share of the risk
 * budget; they never get more than the full budget.
 */
export function convictionScalar(confidence: number, minConfidence = 0.5): number {
  const min = Math.min(Math.max(minConfidence, 0), 0.95);
  const c = Math.min(Math.max(confidence, 0), 1);
  if (c <= min) return 0.4;
  const span = 1 - min;
  return Math.min(1, Math.max(0.4, 0.4 + ((c - min) / (span || 1)) * 0.6));
}

export function computeDynamicSize(input: DynamicSizingInput): DynamicSizingResult {
  const equity = Math.max(0, Number(input.equity) || 0);
  const buffer = Math.min(Math.max(input.balanceBufferPct ?? 0.1, 0), 0.9);
  const usable = Math.max(0, (Number(input.availableBalance) || 0) * (1 - buffer));
  const entry = Number(input.entry) || 0;
  const stop = Number(input.stopLoss ?? 0);
  const stopDistance = stop > 0 && entry > 0 ? Math.abs(entry - stop) : 0;
  const riskPct = Math.max(0, Number(input.riskPct) || 0);
  const scalar = convictionScalar(input.confidence, input.minConfidence ?? 0.5);
  const riskBudget = equity * riskPct;
  const riskAmount = riskBudget * scalar;

  const base = (skipReason?: string): DynamicSizingResult => ({
    qty: 0, notional: 0, maxNotional: 0, riskBudget, riskAmount,
    stopDistance, convictionScalar: scalar, binding: "none",
    diagnostics: "", skipReason,
  });

  if (entry <= 0) return { ...base("invalid entry price"), diagnostics: "entry<=0" };
  if (equity <= 0) return { ...base("no equity available"), diagnostics: "equity<=0" };
  if (usable <= 0) return { ...base("no available balance"), diagnostics: "available<=0" };
  if (stopDistance <= 0) {
    return { ...base("stop-loss required for sizing"), diagnostics: "stop_distance<=0" };
  }

  // 1. Risk-based ceiling: the position whose stop-out loses exactly the
  //    conviction-scaled risk budget.
  const qtyByRisk = riskAmount / stopDistance;
  const notionalByRisk = qtyByRisk * entry;

  // 2. Funds ceiling.
  const notionalByBalance = usable;

  // 3. Portfolio exposure ceiling.
  const headroom = input.exposureHeadroom == null
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Number(input.exposureHeadroom));

  const candidates: { name: string; value: number }[] = [
    { name: "risk_budget", value: notionalByRisk },
    { name: "available_balance", value: notionalByBalance },
    { name: "portfolio_exposure", value: headroom },
  ];
  if (input.maxQty != null && Number.isFinite(input.maxQty)) {
    candidates.push({ name: "inventory", value: Math.max(0, Number(input.maxQty)) * entry });
  }

  const bindingEntry = candidates.reduce((a, b) => (b.value < a.value ? b : a));
  const maxNotional = Math.max(0, bindingEntry.value);

  // Round the QUANTITY down to venue precision so rounding can never push the
  // notional back above the calculated ceiling.
  const qty = floorTo(maxNotional / entry, input.qtyPrecision ?? 8);
  const notional = qty * entry;

  const diagnostics =
    `equity=${equity.toFixed(2)} available=${usable.toFixed(2)} ` +
    `conf=${(Number(input.confidence) || 0).toFixed(2)} conviction=${scalar.toFixed(2)} ` +
    `risk_budget=${riskBudget.toFixed(2)} risk_amount=${riskAmount.toFixed(2)} ` +
    `stop_distance=${stopDistance} max_notional=${maxNotional.toFixed(2)} ` +
    `qty=${qty} final_notional=${notional.toFixed(2)} binding=${bindingEntry.name}`;

  if (!(qty > 0)) {
    return {
      qty: 0, notional: 0, maxNotional, riskBudget, riskAmount, stopDistance,
      convictionScalar: scalar, binding: bindingEntry.name, diagnostics,
      skipReason: `position too small to trade (max notional $${maxNotional.toFixed(2)}, binding ${bindingEntry.name})`,
    };
  }

  return {
    qty, notional, maxNotional, riskBudget, riskAmount, stopDistance,
    convictionScalar: scalar, binding: bindingEntry.name, diagnostics,
  };
}
