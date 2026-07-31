// High-impact event window filter.
//
// The autonomous engine must not open positions immediately around scheduled
// macro releases. We deliberately avoid a third-party calendar dependency
// (rate limits + a hard outage would silently disable the filter). Instead we
// block the recurring UTC windows in which virtually every high-impact US/EU
// release lands, plus weekly session boundaries where liquidity is thin.

export interface EventWindow {
  active: boolean;
  reason?: string;
  minutesToNext?: number;
}

interface Window { hour: number; minute: number; label: string; }

// Recurring high-impact release times (UTC), weekdays only.
const RELEASES: Window[] = [
  { hour: 12, minute: 30, label: "US macro release block (CPI/NFP/PPI window)" },
  { hour: 14, minute: 0, label: "US ISM / consumer data window" },
  { hour: 18, minute: 0, label: "FOMC / rate-decision window" },
  { hour: 8, minute: 30, label: "EU macro release window" },
];

const BEFORE_MIN = 30;
const AFTER_MIN = 30;

export function checkEventWindow(now: Date = new Date()): EventWindow {
  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Weekend / rollover illiquidity: Friday after 20:00 UTC through Sunday 22:00.
  if (day === 6) return { active: true, reason: "Weekend — markets closed or illiquid" };
  if (day === 5 && minutes >= 20 * 60) return { active: true, reason: "Friday close — liquidity drain" };
  if (day === 0 && minutes < 22 * 60) return { active: true, reason: "Sunday pre-open — spreads unreliable" };

  // Daily rollover (23:45–00:15 UTC) — swap charges and spread widening.
  if (minutes >= 23 * 60 + 45 || minutes < 15) {
    return { active: true, reason: "Daily rollover — spread widening" };
  }

  let nextIn = Infinity;
  for (const r of RELEASES) {
    if (day === 0 || day === 6) continue;
    const target = r.hour * 60 + r.minute;
    const delta = target - minutes;
    if (delta <= BEFORE_MIN && delta >= -AFTER_MIN) {
      return { active: true, reason: r.label, minutesToNext: Math.max(0, delta) };
    }
    if (delta > 0) nextIn = Math.min(nextIn, delta);
  }

  return { active: false, minutesToNext: Number.isFinite(nextIn) ? nextIn : undefined };
}
