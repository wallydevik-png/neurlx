# Remaining Completion Roadmap (15 slices)

Shipping one deep slice per turn. Each slice is safety-critical and gets full DB + server + UI wiring.

## Status
- ✅ Slice 1 — Autonomous Trading Engine (shipped last turn: gates, cron, breakers, UI)
- 🔨 Slice 2 — Notification & Alert Intelligence (this turn)
- ⏳ Slice 3 — Onboarding Wizard
- ⏳ Slice 4 — Compliance & User Protection (disclaimers, GDPR export/delete, consent)
- ⏳ Slice 5 — Mobile Experience & PWA (manifest, service worker, mobile shell, biometrics)
- ⏳ Slice 6 — Advanced Analytics & Reporting (benchmark vs BTC/S&P, tax export, periodic reports)
- ⏳ Slice 7 — Market Intelligence & Professional Consensus (provider framework, consensus scoring)
- ⏳ Slice 8 — Alternative Data Engine (orderbook, funding, OI, on-chain, calendar)
- ⏳ Slice 9 — AI Research Lab & Strategy Evolution (ensemble voting, experiments, promotion pipeline)
- ⏳ Slice 10 — Advanced Risk Intelligence (Monte Carlo, stress tests, risk-of-ruin, auto-reduce)
- ⏳ Slice 11 — Institutional Reliability (health monitoring, backups, incident tracking, auto-recovery)
- ⏳ Slice 12 — Capital & Wealth Management (compounding, HWM, reserves, scaling)
- ⏳ Slice 13 — Multi-Asset Expansion (stocks, forex, commodities, ETFs)
- ⏳ Slice 14 — AI Personal Trading Assistant (natural language)
- ⏳ Slice 15 — Public Platform Expansion (optional; multi-tenant, marketplace, copy trading)

Reply "next" between slices.

## This turn — Slice 2: Notifications

### Database
- `notifications` (user_id, kind, severity, title, message, payload jsonb, read_at, created_at)
- `notification_preferences` (user_id PK, channels jsonb, severity_min, quiet_hours_start/end, per-kind toggles jsonb)

### Server
- `src/lib/notifications.functions.ts`: `listNotifications`, `markRead`, `markAllRead`, `getPreferences`, `updatePreferences`, `unreadCount`.
- `src/lib/notifications/emit.server.ts`: `emitNotification(supabase, userId, kind, ...)` — respects prefs + quiet hours, writes to `notifications`, and (for enabled channels) enqueues email via Lovable Emails (stub for SMS/Telegram/Discord until user provides connectors).

### Emission points (wired now)
- `submitOrder` — trade executed / rejected
- `positionManager` — SL / TP / trailing / partial TP triggered
- Autonomous cycle — activated, paused, breaker tripped
- Circuit breakers — daily loss halt, consecutive-loss halt
- Connection health — exchange failure (in monitoring)

### UI
- Bell icon in `AppShell` with unread count.
- `/notifications` — list + filter by severity/kind + mark read + preferences panel (channels, quiet hours, severity floor, per-kind toggles).

### Safety
- Notifications are informational; failure to emit never blocks an order.
- Emergency severity bypasses quiet hours.
