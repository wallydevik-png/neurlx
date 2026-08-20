# Fix the macro-event blocking and clean up cycle telemetry

I audited the pipeline against the prompt you pasted. Most of what it asks for was already fixed in the last round: consensus tie-breaking is direction-neutral (BUY/SELL dead heat resolves to WAIT), confidence uses absolute conviction so SELL clears the same thresholds as BUY, the committee scan uses a bounded worker pool with per-symbol isolation (no `Promise.race` discarding completed work), and each signal already runs inside its own error boundary that emits `signal_failed:<symbol>:<stage>:<reason>`. Re-implementing those would be churn and risk, so this plan does not touch them.

Two things in the prompt are genuinely unfixed, and one of them is exactly what you're seeing.

## The real problem: the "US macro release block"

The event filter does not consult a real economic calendar. It hard-blocks four fixed UTC clock windows every weekday, whether or not any release actually occurs:

```text
08:30 UTC +/-30m   EU macro window
12:30 UTC +/-30m   "US macro release block (CPI/NFP/PPI window)"
14:00 UTC +/-30m   US ISM / consumer window
18:00 UTC +/-30m   FOMC window
plus: all of Saturday, Friday after 20:00, Sunday before 22:00, and 23:45-00:15 daily
```

Your screenshots are all 12:27-12:33 UTC, sitting inside the 12:30 block. That is roughly 4 hours of every weekday plus most of the weekend where nothing can trade — and it is applied identically to crypto, which trades 24/7 and does not observe a US release calendar or a Friday close. ETH-USD and SOL-USD were the blocked candidates.

This is a legitimate safety control for forex, indices, metals and energy. It is misapplied to crypto.

### Changes

1. Make the event window asset-class aware. `checkEventWindow` takes the symbol's asset class:
   - forex / index / metal / energy / equity: current behaviour unchanged, including weekend and Friday-close blocks.
   - crypto (including meme coins): scheduled macro release windows narrowed to a genuine risk window (CPI/NFP/PPI and FOMC only, and only for the minutes immediately around the print rather than a full hour), and the weekend/Friday-close/Sunday-pre-open blocks dropped, since crypto liquidity is continuous. The daily-rollover block is kept.
2. Both call sites (`entryFilters.server.ts` and `executionIntel.server.ts`) pass the symbol so the classification is consistent — the engine cannot block at one gate and allow at the other.
3. The rejection reason gains the class it was applied under, e.g. `News/event window (forex): US macro release block`, so a block is always attributable.

No thresholds, HTF rules, risk gates, wallet checks or broker restrictions are weakened; forex and index behaviour is byte-for-byte the same.

## Telemetry: deferred is currently invisible

The cycle already avoids counting budget-exceeded signals as rejected — it breaks out and leaves them pending — but `deferred` is only written into a free-text `errors` string. The dashboard therefore shows `scanned 10 / executed 0 / rejected 1` with three signals silently unaccounted for.

### Changes

- Add `deferred` and `failed` to the cycle result and persist them on the run row.
- Emit `signal_deferred:<symbol>:cycle_budget` per unstarted signal instead of a single aggregate string.
- Show scanned / executed / rejected / deferred / failed as distinct counters on the Autonomous Engine page, and render safety rejections (news window, risk gate, portfolio) in a neutral colour rather than the red "errors" style — a macro block is not an infrastructure error and should not read like one.

## Tests

- `checkEventWindow`: crypto is not blocked at 12:30 UTC or on a Saturday; forex still is; both are blocked during daily rollover.
- Consensus: BUY majority, SELL majority, WAIT majority, BUY/SELL tie -> WAIT, three-way split -> deterministic (locks in the existing behaviour so it cannot regress).
- Cycle counters: a budget cut-off produces deferred, not rejected.

## Technical notes

Files touched: `src/lib/analysis/eventWindow.ts`, `src/lib/trading/entryFilters.server.ts`, `src/lib/execution/executionIntel.server.ts`, `src/lib/autonomous.functions.ts`, `src/routes/_authenticated/autonomous.tsx`, plus a migration adding `signals_deferred` / `signals_failed` to `autonomous_runs`, and test files.

Not changed: committee consensus, confidence maths, HTF filter, sizing, risk gate, wallet/venue logic, broker filtering. The audit found those already direction-symmetric; if a live SELL still gets corrupted after this, that becomes a separate targeted investigation with a reproduction rather than a speculative rewrite.
