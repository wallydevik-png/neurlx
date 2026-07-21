
# Making NeurlX Actually Trade

You want three things: stop feeling like a demo, link a real broker without MetaApi, and let the AI trade automatically after linking. Here is exactly what I'll ship.

## 1. Pick the right broker (direct API, no bridge)

Since MT5 requires the MetaApi bridge (and you said no), the realistic direct-API options already wired in NeurlX are:

| Broker | Assets | Account type | Signup |
|---|---|---|---|
| **Alpaca** | US stocks + crypto | Real **paper** account (free) or funded live | alpaca.markets → generate API key/secret |
| **Binance** | Crypto spot | Live only (funded) | binance.com → API Management |
| **Bybit** | Crypto spot/perps | Live or Testnet | bybit.com → API |
| **OANDA** | Forex/CFD | Demo (free) or live | oanda.com → v20 API token |
| **Kraken / OKX** | Crypto | Live | provider dashboards |

**My recommendation: Alpaca** — it gives you a real broker-issued paper account (real market data, real order flow through Alpaca's matching engine, $100k paper cash) that feels identical to live, then flip the same key to a funded live account when ready. This is the fastest way to see NeurlX actually place orders today.

## 2. Per-account Demo ↔ Live switch

- Add `account_mode` (`paper` | `live`) to `exchange_connections`, defaulting to `paper`.
- Account card shows a **Demo / Live** toggle. Switching to Live requires: verified connection, no withdrawal permission, and a one-time confirmation.
- Execution engine already routes to the right connector; I'll gate live orders on `account_mode === 'live'` and keep paper orders on the internal paper book.
- Dashboard, positions, P&L, and analytics filter by the active account so the numbers you see are the numbers of the account you're using — no more mixed synthetic feel.

## 3. One-click auto-trade after linking

New flow on `/accounts/[id]`:

1. **Test Connection** → runs balance + permission scan.
2. **Enable Auto-Trading** button → sets `automation_settings.mode = 'autonomous'`, `kill_switch_active = false`, binds the strategy to this account, and starts the cron cycle for your user.
3. Live status strip: "AI trading on {broker} · Demo · last signal 2m ago · next scan 58s".

The autonomous cron (`/api/public/cron/autonomous`) already exists and runs the AI cycle for every user in autonomous mode. I'll wire the account link to it and add a visible "Last cycle ran … · Next in …" indicator so you can see it's alive.

## 4. Kill the "simulation" feel

- Replace synthetic Intel/AltData providers with a clear **"Not connected"** state + a "Connect data source" CTA on `/intel` and `/altdata` so nothing renders fake numbers.
- Landing dashboard shows real values from your connected account (balance, positions, P&L) or an empty state — no placeholder graphs.
- Every page gets a short **"What this does"** helper card at the top (1–2 sentences) so features stop feeling opaque.

## 5. Fix the "MT5 linking isn't working"

I'll add a clear banner on the MT5 form: *"MT5 requires a MetaApi.cloud bridge (free tier). Paste your MetaApi token + account ID here, not your MT5 login."* — plus a "Use Alpaca instead" shortcut. This removes the confusion without breaking users who do have MetaApi.

## Technical details

- **DB migration**: add `account_mode`, `is_active_account` columns to `exchange_connections`; add `user_id` unique on `is_active_account = true`.
- **Backend**: `setAccountMode`, `setActiveAccount`, `enableAutoTradingForAccount` server functions (all `requireSupabaseAuth`). Execution engine reads active account + mode.
- **Frontend**: rewrite `accounts.$id.activate.tsx` into a real account detail page with Test / Demo-Live toggle / Enable-AI button / live status. Add a global "Active Account" chip in the AppShell header. Add helper cards to the 8 most-used routes.
- **Autonomous loop**: bind runs to the active account and log each cycle to `autonomous_runs` with a visible timestamp on the dashboard.

## What I need from you

Just confirm: **Alpaca** for the first real link (free paper account, 2-minute signup), or pick a different broker from the table above. I'll ship the whole slice in one go and you'll be able to press "Enable Auto-Trading" after pasting the API key.
