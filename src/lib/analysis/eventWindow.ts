// High-impact event window filter.
//
// The autonomous engine must not open positions immediately around scheduled
// macro releases. We deliberately avoid a third-party calendar dependency
// (rate limits + a hard outage would silently disable the filter). Instead we
// block the recurring UTC windows in which virtually every high-impact US/EU
// release lands, plus weekly session boundaries where liquidity is thin.
//
// The blocks are asset-class aware. Forex, indices, metals and energy trade on
// scheduled sessions and react violently to macro prints, so they keep the full
// block set. Crypto trades continuously, has no Friday close and no Sunday
// pre-open, and only reacts materially to the top-tier US prints — applying the
// forex calendar to it removed roughly four hours of every weekday plus the
// entire weekend from a 24/7 market for no risk benefit.

import { classifySymbol, type AssetClass } from "@/lib/marketdata/assetClass";

export interface EventWindow {
  active: boolean;
  reason?: string;
  minutesToNext?: number;
  /** Asset class the window rules were applied under — always attributable. */
  assetClass: AssetClass;
}

interface Window {
  hour: number;
  minute: number;
  label: string;
  /** Also applied to continuously traded crypto markets. */
  cryptoRelevant?: boolean;
}

// Recurring high-impact release times (UTC), weekdays only.
const RELEASES: Window[] = [
  { hour: 12, minute: 30, label: "US macro release block (CPI/NFP/PPI window)", cryptoRelevant: true },
  { hour: 14, minute: 0, label: "US ISM / consumer data window" },
  { hour: 18, minute: 0, label: "FOMC / rate-decision window", cryptoRelevant: true },
  { hour: 8, minute: 30, label: "EU macro release window" },
];

const BEFORE_MIN = 30;
const AFTER_MIN = 30;

// Crypto only stands down for the minutes immediately around the print rather
// than a full hour on either side.
const CRYPTO_BEFORE_MIN = 5;
const CRYPTO_AFTER_MIN = 10;

/** True for markets that trade continuously and observe no session calendar. */
function isContinuous(cls: AssetClass): boolean {
  return cls === "crypto";
}

export function checkEventWindow(
  now: Date = new Date(),
  symbolOrClass?: string | AssetClass | null,
): EventWindow {
  const assetClass: AssetClass = !symbolOrClass
    ? "unknown"
    : (["crypto", "forex", "index", "metal", "energy", "equity", "unknown"] as const)
        .includes(symbolOrClass as AssetClass)
      ? (symbolOrClass as AssetClass)
      : classifySymbol(symbolOrClass);

  const continuous = isContinuous(assetClass);
  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Session-boundary illiquidity. Only meaningful for markets that actually
  // close — crypto has no weekend and no Friday drain.
  if (!continuous) {
    if (day === 6) return { active: true, reason: "Weekend — markets closed or illiquid", assetClass };
    if (day === 5 && minutes >= 20 * 60) return { active: true, reason: "Friday close — liquidity drain", assetClass };
    if (day === 0 && minutes < 22 * 60) return { active: true, reason: "Sunday pre-open — spreads unreliable", assetClass };
  }

  // Daily rollover (23:45–00:15 UTC) — swap charges and spread widening.
  // Applies to every venue, including crypto perpetuals.
  if (minutes >= 23 * 60 + 45 || minutes < 15) {
    return { active: true, reason: "Daily rollover — spread widening", assetClass };
  }

  const before = continuous ? CRYPTO_BEFORE_MIN : BEFORE_MIN;
  const after = continuous ? CRYPTO_AFTER_MIN : AFTER_MIN;

  let nextIn = Infinity;
  for (const r of RELEASES) {
    if (day === 0 || day === 6) continue;
    if (continuous && !r.cryptoRelevant) continue;
    const target = r.hour * 60 + r.minute;
    const delta = target - minutes;
    if (delta <= before && delta >= -after) {
      return { active: true, reason: r.label, minutesToNext: Math.max(0, delta), assetClass };
    }
    if (delta > 0) nextIn = Math.min(nextIn, delta);
  }

  return { active: false, minutesToNext: Number.isFinite(nextIn) ? nextIn : undefined, assetClass };
}
