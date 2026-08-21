# Stabilize autonomous execution and memecoin sniper

## Objective
Make the live engines operational and auditable without weakening any confidence, HTF, momentum, portfolio, risk, sizing, wallet, execution, or kill-switch rule.

## Autonomous engine

1. **Correct HTF outcome semantics**
   - Keep each candidate’s original BUY/SELL direction separate from HTF data state.
   - Classify provider/queue/readiness failures as `signal_failed`, cycle exhaustion as `signal_deferred`, and only measured directional conflicts as `signal_rejected`.
   - Preserve successful 1D/4H/1H results when another timeframe fails and preserve completed symbols when peers time out.

2. **Align timeout hierarchy with measured provider behavior**
   - Make provider request, HTF stage, cycle, and watchdog deadlines explicitly ordered.
   - Give the HTF stage enough room for the existing per-timeframe provider ceilings while retaining the bounded cycle and stale-cycle fence.
   - Do not hold history slots during readiness, reconnection, scoring, or other non-history work.

3. **Fix candle reuse and cancellation accounting**
   - Audit all committee, HTF, entry, momentum, portfolio, lifecycle, and execution candle calls.
   - Reuse real broker candles by account + symbol + timeframe + requested range/limit within a short freshness window.
   - Correct shared-request consumer accounting so completed/cancelled consumers cannot incorrectly abort work still needed elsewhere.
   - Never cache synthetic data or failures as successful broker data.

4. **Make per-symbol telemetry explicit**
   - Record each symbol through market data, committee, HTF, momentum, entry, portfolio, risk, execution, deferred, failed, rejected, or executed.
   - Include HTF per-timeframe timing/reason and portfolio score components in cycle traces.
   - Keep legitimate momentum and portfolio-manager failures as rejections with their existing thresholds.

5. **Verify directional symmetry and execution persistence**
   - Audit BUY → long and SELL → short through generation, HTF, momentum, portfolio, risk, broker submission, and stored positions.
   - Retain spot SELL base-balance enforcement and margin short capability checks.

## Memecoin sniper

1. **Use a real rotating discovery universe**
   - Replace repeated `SOL/pump/WIF/BONK` search-only discovery with broader live Solana token discovery feeds, deduplicated by mint and best-liquidity pool.
   - Keep the existing liquidity, momentum, rug-risk, score, wallet, loss-cap, and position-limit gates unchanged.

2. **Expose actual cycle activity**
   - Persist and display the current cycle’s scanned candidates, qualified targets, skipped reasons, attempted entries, failures, and successful swaps.
   - Separate the live target list from older observations so users can see which memecoins the sniper is actively evaluating and trading.

3. **Harden wallet and execution paths**
   - Bound RPC calls and record endpoint-specific failures without hiding a successful fallback.
   - Verify funded wallet selection, SOL/token balances, Jupiter quote/build/send, and position persistence end to end.

## Tests and live verification

- Add focused tests for provider concurrency, coalescing/account isolation, cancellation isolation, per-timeframe HTF retention, failure/deferred/rejection classification, completed-result retention, BUY/SELL symmetry, portfolio/momentum symmetry, and spot-vs-margin SELL behavior.
- Add sniper tests for rotating discovery, mint deduplication, settings persistence, candidate classification, wallet/RPC fallback, and execution outcome reporting.
- Run the complete test suite; the platform automatically checks type safety and build health.
- Mint a safe authenticated preview session, run several back-to-back autonomous and sniper cycles against current live data, inspect server/database traces after each cycle, and iterate on infrastructure/code errors only.
- A successful order will only be submitted when the unchanged trading gates produce a valid setup; no trade will be forced merely to satisfy testing.

## Deliverable
Report exact root causes, files changed, architecture changes, tests and counts, type/build results, BUY/SELL verification, live-cycle outcomes, and explicitly confirm that no trading threshold or risk gate changed.
