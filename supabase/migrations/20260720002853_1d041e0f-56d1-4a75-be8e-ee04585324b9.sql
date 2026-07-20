
-- ============================================================
-- 1. exchange_connections: permission scan + per-connection cap
-- ============================================================
ALTER TABLE public.exchange_connections
  ADD COLUMN IF NOT EXISTS trading_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_notional_per_order numeric(20,8) DEFAULT 50,
  ADD COLUMN IF NOT EXISTS permission_scan jsonb,
  ADD COLUMN IF NOT EXISTS withdrawal_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS unnecessary_permissions text[] NOT NULL DEFAULT '{}';

-- ============================================================
-- 2. automation_settings: live trading toggle + circuit breaker
-- ============================================================
ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS live_trading_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS live_max_notional_per_order numeric(20,8) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS live_consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS live_rejected_today integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS live_kill_until timestamptz,
  ADD COLUMN IF NOT EXISTS live_kill_reason text,
  ADD COLUMN IF NOT EXISTS activation_confirmed_phrase_at timestamptz;

-- ============================================================
-- 3. orders: richer order types + retry state
-- ============================================================
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS stop_price numeric(20,8),
  ADD COLUMN IF NOT EXISTS trailing_stop_pct numeric(6,4),
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS parent_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_live boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS execution_venue text NOT NULL DEFAULT 'paper',
  ADD COLUMN IF NOT EXISTS external_order_id text;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_type_check
  CHECK (order_type = ANY (ARRAY['market','limit','stop','stop_limit','trailing_stop']));

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_status_check
  CHECK (status = ANY (ARRAY['pending','working','partially_filled','filled','cancelled','rejected','error','retrying']));

-- ============================================================
-- 4. positions: profit-protection + duration tracking
-- ============================================================
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS original_qty numeric(20,8),
  ADD COLUMN IF NOT EXISTS filled_qty numeric(20,8),
  ADD COLUMN IF NOT EXISTS partial_take_profit_pct numeric(6,4),
  ADD COLUMN IF NOT EXISTS break_even_moved boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trailing_high_water numeric(20,8),
  ADD COLUMN IF NOT EXISTS trailing_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS duration_seconds integer,
  ADD COLUMN IF NOT EXISTS ai_regime text,
  ADD COLUMN IF NOT EXISTS strategy_id uuid;

-- ============================================================
-- 5. execution_log — immutable per-order event stream
-- ============================================================
CREATE TABLE IF NOT EXISTS public.execution_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  position_id uuid REFERENCES public.positions(id) ON DELETE SET NULL,
  event text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','error','critical')),
  message text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS execution_log_user_created_idx
  ON public.execution_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS execution_log_order_idx
  ON public.execution_log (order_id);

GRANT SELECT ON public.execution_log TO authenticated;
GRANT ALL ON public.execution_log TO service_role;
ALTER TABLE public.execution_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS execution_log_owner_read ON public.execution_log;
CREATE POLICY execution_log_owner_read ON public.execution_log
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Owner can insert own rows (execution engine runs as the authenticated user)
DROP POLICY IF EXISTS execution_log_owner_write ON public.execution_log;
CREATE POLICY execution_log_owner_write ON public.execution_log
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- ============================================================
-- 6. trade_journal — per-trade retrospective
-- ============================================================
CREATE TABLE IF NOT EXISTS public.trade_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position_id uuid REFERENCES public.positions(id) ON DELETE SET NULL,
  signal_id uuid REFERENCES public.signals(id) ON DELETE SET NULL,
  symbol text NOT NULL,
  side text NOT NULL,
  entry_reason text,
  exit_reason text,
  ai_confidence numeric(4,3),
  market_regime text,
  entry_price numeric(20,8),
  exit_price numeric(20,8),
  qty numeric(20,8),
  realized_pnl numeric(20,8),
  fees_total numeric(20,8) DEFAULT 0,
  slippage_bps_avg numeric(10,4),
  execution_quality_score numeric(4,2),
  user_modifications integer NOT NULL DEFAULT 0,
  duration_seconds integer,
  lessons text,
  strategy_id uuid,
  model_version text,
  indicators jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trade_journal_user_idx ON public.trade_journal (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_journal TO authenticated;
GRANT ALL ON public.trade_journal TO service_role;
ALTER TABLE public.trade_journal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trade_journal_owner_all ON public.trade_journal;
CREATE POLICY trade_journal_owner_all ON public.trade_journal
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
