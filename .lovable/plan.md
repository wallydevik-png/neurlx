# Fix HTF cycle-budget exhaustion

## Objective
Make HTF scheduling use the existing four-slot account history limit efficiently so most eligible symbols receive a measured classification within the current cycle budget, without changing any trading or safety rule.

## Root cause to address
- The autonomous cycle calls the HTF filter with symbol concurrency forced to `1`.
- Each symbol launches 1D, 4H, and 1H together, so only three of four allowed provider slots are used while every later symbol waits behind the current symbol.
- The HTF stage has a shared abort deadline; once it expires, queued symbols are marked deferred even though the provider and committee were healthy.
- Current telemetry aggregates all history calls and does not expose HTF symbol/timeframe lifecycle or coalescing counts, making queue starvation hard to distinguish from provider latency.

## Implementation

1. **Add cycle-scoped request telemetry**
   - Extend history timings with queued, provider-start, completion/cancellation timestamps and retain queue/provider/total durations, outcome, reason, active count, and peak concurrency.
   - Add candle-cache telemetry for provider starts, cache hits, and in-flight coalesced joins, scoped by cursor so each cycle reports its own counts.
   - Emit HTF per-symbol/per-timeframe timing and outcome summaries plus cycle elapsed time.

2. **Replace serial HTF processing with fair bounded scheduling**
   - Keep the account history gate and its maximum of four provider requests unchanged.
   - Schedule eligible symbols concurrently with a small bounded pool while the gate remains the sole provider concurrency authority.
   - Use fair per-symbol progression so one slow symbol cannot monopolize the stage; do not start work that cannot fit inside the remaining stage/cycle reserve.
   - Preserve committee ranking/order as the only candidate priority; do not add profitability prediction or change eligibility.

3. **Preserve partial timeframe and symbol results**
   - Track 1D, 4H, and 1H independently with settled results rather than losing completed timeframes when a sibling is cancelled.
   - Keep completed verdicts from other symbols when one symbol is slow.
   - Treat never-started or stage-cancelled measurement as `signal_deferred`; keep genuine provider failures as infrastructure failures and measured contradictions as rejections.
   - Leave HTF alignment/classification rules unchanged.

4. **Correct budget accounting**
   - Derive the HTF deadline from the cycle’s actual remaining time and an explicit downstream reserve.
   - Bound queue/provider budgets to the remaining HTF window instead of granting each late request a fresh full timeout.
   - Keep the 40-second cycle budget and existing watchdog unchanged.

5. **Verify candle reuse**
   - Audit committee, HTF, entry, momentum, portfolio, risk, and execution-intel requests against the canonical account + symbol + timeframe cache key.
   - Preserve one in-flight real broker request per canonical key, tail slicing for smaller callers, and no caching of synthetic data or failures.
   - Fix only duplicate/cancellation accounting defects found by tests; do not alter analytical logic.

## Tests and verification
- Add tests for fair bounded scheduling, four-slot maximum, slow-symbol isolation, partial 1D/4H retention, completed-symbol retention, deferred-vs-failed semantics, remaining-budget propagation, and duplicate/coalesced request counting.
- Run the focused HTF/history/coalescing tests and the full test suite; confirm the generated build remains healthy.
- Run several authenticated back-to-back live autonomous cycles and report per cycle: scanned, committee completed, HTF completed/deferred/failed, queue average/p95, provider average/p95, peak provider concurrency, cache/coalescing counts, and elapsed time.
- Compare before/after HTF completion and defer rates. A trade is never forced.

## Guardrail confirmation
No confidence threshold, HTF confirmation rule, momentum rule, portfolio-manager threshold, risk rule, sizing rule, wallet rule, execution rule, kill switch, or watchdog duration will be changed.
