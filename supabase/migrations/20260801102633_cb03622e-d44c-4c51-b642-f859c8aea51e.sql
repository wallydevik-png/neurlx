CREATE TABLE public.execution_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  signal_id uuid,
  strategy_id uuid,
  symbol text not null,
  side text not null,
  entry_score numeric not null default 0,
  action text not null default 'reject',
  order_type text not null default 'market',
  limit_price numeric,
  stop_loss numeric,
  take_profit numeric,
  risk_reward numeric,
  grade text not null default 'F',
  confidence numeric not null default 0,
  session text,
  session_score numeric,
  volatility_state text,
  expected_value numeric,
  win_probability numeric,
  approved boolean not null default false,
  shadow_only boolean not null default false,
  mtf jsonb not null default '{}'::jsonb,
  components jsonb not null default '{}'::jsonb,
  liquidity jsonb not null default '{}'::jsonb,
  rejections jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.execution_decisions TO authenticated;
GRANT ALL ON public.execution_decisions TO service_role;
ALTER TABLE public.execution_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own execution_decisions" ON public.execution_decisions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX execution_decisions_user_created_idx ON public.execution_decisions(user_id, created_at DESC);

CREATE TABLE public.trade_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  position_id uuid,
  decision_id uuid,
  symbol text not null,
  side text not null,
  entry_score numeric,
  grade text,
  session text,
  regime text,
  entry_timing text,
  indicators jsonb not null default '{}'::jsonb,
  market_condition jsonb not null default '{}'::jsonb,
  outcome text,
  profit numeric,
  r_multiple numeric,
  max_favorable_excursion numeric,
  max_adverse_excursion numeric,
  hold_seconds integer,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_memory TO authenticated;
GRANT ALL ON public.trade_memory TO service_role;
ALTER TABLE public.trade_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trade_memory" ON public.trade_memory FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE UNIQUE INDEX trade_memory_position_idx ON public.trade_memory(position_id) WHERE position_id IS NOT NULL;

CREATE TABLE public.execution_model_params (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null default 1,
  params jsonb not null default '{}'::jsonb,
  trades_evaluated integer not null default 0,
  late_entries integer not null default 0,
  early_entries integer not null default 0,
  perfect_entries integer not null default 0,
  active boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.execution_model_params TO authenticated;
GRANT ALL ON public.execution_model_params TO service_role;
ALTER TABLE public.execution_model_params ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own execution_model_params" ON public.execution_model_params FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.execution_backtests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  baseline jsonb not null default '{}'::jsonb,
  candidate jsonb not null default '{}'::jsonb,
  p_value numeric,
  confidence numeric,
  promoted boolean not null default false,
  summary text,
  created_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.execution_backtests TO authenticated;
GRANT ALL ON public.execution_backtests TO service_role;
ALTER TABLE public.execution_backtests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own execution_backtests" ON public.execution_backtests FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS exec_intel_enabled boolean not null default true,
  ADD COLUMN IF NOT EXISTS exec_min_confidence numeric not null default 0.90,
  ADD COLUMN IF NOT EXISTS exec_model_version integer not null default 1,
  ADD COLUMN IF NOT EXISTS exec_session_filter_enabled boolean not null default true;

ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS sl_tp_mode text not null default 'ai',
  ADD COLUMN IF NOT EXISTS entry_score numeric,
  ADD COLUMN IF NOT EXISTS trade_grade text;