# Roadmap: 5 vertical slices

You've asked for ~5 major slices in one turn. Each is 6–15 files of dense, safety-critical code. Shipping all at once means every piece is scaffolded shallowly — the opposite of what a real-money execution engine should be. I'll sequence them and ship one deep, verified slice per turn.

## Turn order

1. **Production Execution Engine** (this turn) — real Binance order placement, assisted-mode only. Autonomous stays disabled.
2. **Autonomous Trading Engine** — scheduler, queue, trailing management, regime-aware pausing, instant pause/resume.
3. **Market Intelligence & Professional Consensus Engine** — provider framework, consensus scoring, reliability scoring, dashboard.
4. **Alternative Data Engine** — market structure, derivatives, on-chain, events; feature-contribution UI.
5. **AI Research Lab + Advanced Risk Intelligence** — combined: strategy discovery, ensemble voting, Monte Carlo, stress tests, dynamic risk adjustment, promotion pipeline.

## This turn — Production Execution Engine

Keep the current architecture. Only the connector and pre/post-trade layers change.

### Real Binance execution
- Extend `src/lib/connectors/binance.server.ts` with a signed `placeOrder` supporting MARKET, LIMIT, STOP_LOSS_LIMIT, TAKE_PROFIT_LIMIT via `POST /api/v3/order`.
- Idempotent `newClientOrderId` derived from `${orderRow.id}` (uuid → base36, ≤36 chars).
- `cancelOrder` via `DELETE /api/v3/order`, order lookup via `GET /api/v3/order`.
- Every request/response captured to a new `api_request_log` table (method, path, status, latency_ms, sanitized body, error).

### Pre-trade validation (new `preTradeCheck.server.ts`)
Runs before `submitOrder` for any `is_live` order:
- Connection health: `GET /api/v3/ping` + `/api/v3/time` clock skew < 5s.
- API permissions: `GET /sapi/v1/account/apiRestrictions` — require `enableSpotAndMarginTrading`, reject if `enableWithdrawals`.
- Available balance vs order notional.
- Existing `evaluateRisk()` gate (unchanged — never bypassed).
- SL & TP required (existing rule, enforced here too).
- Symbol filters from `exchangeInfo` (LOT_SIZE, MIN_NOTIONAL, PRICE_FILTER) — round qty/price to valid steps.

### Post-trade reconciliation (new `reconcile.server.ts`)
- After `placeOrder`, poll `GET /api/v3/order` until `status ∈ {FILLED, PARTIALLY_FILLED, CANCELED, EXPIRED, REJECTED}` (max 10s, backoff).
- Persist `external_order_id`, average fill price, cumulative fees (from `/myTrades`), status.
- Sync `positions` row from actual exchange fills, not requested qty.
- Nightly + on-demand reconcile pass that fetches open orders & balances and repairs local drift.

### Failure handling
- Retry only on 5xx / network / `-1003` rate-limit with exponential backoff (already scaffolded — extend classification).
- Never retry on 4xx business errors (insufficient balance, filter failure).
- Duplicate detection: on `-2010` "duplicate clientOrderId" → treat as success, fetch existing order.
- Partial fill: existing schema already supports; reconciler updates `qty` + `status`.
- Existing circuit breaker (3 failures → daily halt) stays.

### Live monitoring
- New `execution_health` view (or server fn) computing over last 24h: avg API latency, execution latency, slippage bps p50/p95, fill rate, error count, last successful ping.
- Extend `/monitoring` page with an "Execution Health" panel.

### Routing switch
- `routeConnector()` in `engine.server.ts` currently hard-forces paper. Change: when `req.live === true` AND connection.trading_enabled AND circuit breaker closed AND connection is Binance → return real Binance connector. All other cases still route to paper.
- `approvals.tsx`: when approving on a live-enabled connection, submit with `live: true`. Autonomous mode remains locked (existing `automation_settings.mode` UI already prevents selecting autonomous — verify).

### Audit
- Reuse `execution_log` for lifecycle events (already in place).
- New `api_request_log` table for raw API traffic (redacted headers, no secrets).
- Every validation decision (pass/fail + reason) logged to `execution_log` with severity.

### Migration
- New table `api_request_log` (user_id, connection_id, method, path, status, latency_ms, request_body_redacted jsonb, response_snippet text, error text, created_at) + RLS + GRANTs.
- Add columns to `exchange_connections`: `last_reconcile_at`, `clock_skew_ms`, `permission_scan jsonb` (already exists — verify).

### Files (this turn)
- MIGRATION: `api_request_log` table.
- EDIT `src/lib/connectors/binance.server.ts` — add signed POST/DELETE/GET order, exchangeInfo cache, apiRestrictions, request logger.
- EDIT `src/lib/connectors/factory.server.ts` — no change (already wires binance).
- NEW `src/lib/execution/preTradeCheck.server.ts`.
- NEW `src/lib/execution/reconcile.server.ts`.
- EDIT `src/lib/execution/engine.server.ts` — real routing, pre-check call, reconcile call, better error classification.
- EDIT `src/routes/_authenticated/monitoring.tsx` — execution health panel.
- EDIT `src/routes/_authenticated/approvals.tsx` — pass `live: true` when connection allows.
- EDIT `src/lib/monitoring.functions.ts` — expose execution health server fn.

### Safety invariants preserved
- `evaluateRisk()` runs on every path — real or paper.
- `checkCircuitBreaker()` runs before any order.
- Autonomous mode selection remains disabled in UI.
- SL + TP required.
- Withdraw-enabled keys refused at activation and re-checked pre-trade.
- Read-only mode remains default; explicit user activation with typed phrase still required (already built).

Reply "go" to ship turn 1, or push back on the sequencing.