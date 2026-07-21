# NeurlX Universal Broker Integration — Developer Guide

Every broker and exchange NeurlX supports flows through **one** provider-
agnostic interface: `TradingConnector` in `src/lib/connectors/types.ts`. The
Execution Engine, Autonomous Trading, Portfolio Manager, Risk Engine,
Mission Control, Analytics and Validation modules **do not know which
broker is behind a connection** — they only ever see this interface.

## Architecture

```
+-----------------------------+     descriptor + capabilities
|  brokerRegistry.ts          |------------------------------\
|  (client-safe UI catalog)   |                              |
+-----------------------------+                              v
                                                +-----------------------+
+-----------------------------+                 |  capabilities.ts       |
|  Wizard (accounts.new.tsx)  |<----------------|  (feature matrix)      |
+-----------------------------+                 +-----------------------+
                                                              |
+-----------------------------+                               |
|  factory.server.ts          |<-- dispatch by connector id --+
|  createConnector(id, creds) |
+-----------------------------+
        |            |            |            |            |
        v            v            v            v            v
   binance/     bybit/       okx/         kraken/      mt5 bridge
   alpaca/      oanda/       generic/     paper/       (Octa, Exness, ...)
        \____________________________ TradingConnector ______/
                                    |
                                    v
        Execution · Portfolio · Risk · Mission Control · Notifications
```

## Adding a new broker

1. **Registry descriptor** in `src/lib/connectors/brokerRegistry.ts`
   — display name, category, auth method, credential fields, docs URL.
2. **Capability row** in `src/lib/connectors/capabilities.ts`
   — declare which features the venue's official API actually supports.
3. **Server connector** in `src/lib/connectors/<broker>.server.ts`
   — implement `TradingConnector`. Use `signing.server.ts` and
   `rest.server.ts` for shared HMAC/REST plumbing so audit logs stay
   consistent.
4. **Factory dispatch** in `src/lib/connectors/factory.server.ts`
   — add the case that instantiates the connector.
5. **Test suite** picks the new connector up automatically — every
   connection can be tested from the Connected Accounts page.

Nothing else in the codebase needs to change. The engine consumes the
new broker through the same interface as every other one.

## Authentication flows

| Method       | Where credentials come from                          |
|--------------|------------------------------------------------------|
| `api_key`    | User pastes venue-issued key + secret (± passphrase) |
| `oauth`      | Browser-redirect OAuth 2.0 with refresh rotation     |
| `metatrader` | MetaApi cloud bridge token + MT account ID           |
| `sdk`        | User points NeurlX at a locally-running SDK gateway  |
| `paper`      | No credentials — simulated venue                     |

Never accept plain broker website passwords except when an **official**
authentication protocol requires them (MT login/password over the
MetaQuotes-approved bridge). All credentials are AES-256-GCM encrypted
via `src/lib/crypto.server.ts` before hitting the database.

## Withdrawal-permission enforcement

- **At save time**: any credential field name containing "withdraw" is
  rejected before the row is inserted.
- **At verification time**: the connector's `getApiPermissions()` is
  called. If the venue reports the key has withdrawal rights, the
  connection is auto-revoked, credentials are wiped, and an audit-log
  entry is written.

## Test suite

`src/lib/connectors/testSuite.server.ts` runs a soft-failing battery
against any connection: authentication, health/latency, permissions,
withdrawal-block, market data, balances, positions, history, and order-
management capability. Order placement is **never** attempted against
real accounts — that is validated by real assisted-mode trades so we
never spend a user's capital on a test.

## Production connectors shipped

| Broker              | Auth      | Status                    |
|---------------------|-----------|---------------------------|
| Paper Trading       | paper     | first-class               |
| Binance             | api_key   | first-class (spot + perp) |
| Bybit               | api_key   | first-class (v5)          |
| OKX                 | api_key   | first-class (v5)          |
| Kraken              | api_key   | first-class               |
| Alpaca              | api_key   | first-class               |
| OANDA               | api_key   | first-class (v20)         |
| MetaTrader 5/4      | bridge    | first-class (MetaApi)     |
| Octa / Exness / IC Markets / Pepperstone / FP Markets / XM | bridge | routed via MT5 |
| Coinbase / KuCoin / Bitget / Gate.io / HTX / MEXC / Crypto.com / Tradier / TradeStation / IBKR / FXCM | api_key / oauth / sdk | framework-ready — see checklist below |

## Framework-ready checklist for the remaining venues

Each item below has a registry descriptor + capability row already, so
first-class rollout is a one-file change:

- Coinbase Advanced Trade — implement EC-JWT signing (ES256, PKCS8
  private key). Web Crypto supports this natively; follow the OKX
  connector shape and swap `hmacSha256Base64` for the JWT.
- KuCoin / Bitget — HMAC-SHA256 base64 + passphrase; use `signing.server.ts`
  the same way OKX does.
- Gate.io / HTX / MEXC — HMAC-SHA256 hex; identical to Binance.
- Crypto.com Exchange — HMAC-SHA256 hex with param sort.
- Tradier / TradeStation — OAuth 2.0 with refresh rotation; use the same
  auth-middleware pattern as the Coinbase OAuth route.
- IBKR — HTTPS Client Portal Gateway; user provides gateway URL, so
  connector becomes a thin proxy to `POST /iserver/orders`.
- FXCM — REST token flow; treat like OANDA but with different endpoint
  paths.

## Troubleshooting

| Symptom                                | Cause / fix                                                            |
|----------------------------------------|------------------------------------------------------------------------|
| Test suite: `withdrawal-block` fails   | The venue-issued key has withdrawal rights. Revoke and reissue.        |
| Test suite: `authentication` fails     | Wrong key, expired token, IP allowlist mismatch, or clock skew > 5s.   |
| Kraken: "EAPI:Invalid signature"       | Private key must be the raw base64 from the "Add Key" dialog.          |
| MT5: "auth-token invalid"              | MetaApi provisioning token expired — rotate under MetaApi dashboard.    |
| OANDA: `403 Forbidden`                 | Wrong environment (`practice` vs `live`) or wrong account ID.          |
| Alpaca: `403 Forbidden`                | Using paper key against live base URL or vice versa.                   |
| Bybit: `10003 API key is invalid`      | Key was created before enabling Unified Trading Account.               |
