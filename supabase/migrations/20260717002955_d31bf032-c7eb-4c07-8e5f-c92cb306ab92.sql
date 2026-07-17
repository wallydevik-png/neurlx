
-- strategies (saved configurations)
CREATE TABLE public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  symbol text not null,
  interval text not null default '15m',
  params jsonb not null default '{}'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategies TO authenticated;
GRANT ALL ON public.strategies TO service_role;
ALTER TABLE public.strategies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own strategies" ON public.strategies FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER strategies_touch BEFORE UPDATE ON public.strategies
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- backtest_runs
CREATE TABLE public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  strategy_id uuid references public.strategies(id) on delete set null,
  parent_run_id uuid references public.backtest_runs(id) on delete cascade,
  kind text not null default 'single' check (kind in ('single','walkforward_train','walkforward_validation','walkforward_oos')),
  label text,
  symbol text not null,
  interval text not null,
  from_ts timestamptz not null,
  to_ts timestamptz not null,
  params jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  equity_curve jsonb not null default '[]'::jsonb,
  status text not null default 'complete',
  error text,
  created_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backtest_runs TO authenticated;
GRANT ALL ON public.backtest_runs TO service_role;
ALTER TABLE public.backtest_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own runs" ON public.backtest_runs FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX backtest_runs_user_created_idx ON public.backtest_runs(user_id, created_at DESC);

-- backtest_trades
CREATE TABLE public.backtest_trades (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  side text not null check (side in ('long','short')),
  entry_ts timestamptz not null,
  entry_price numeric not null,
  exit_ts timestamptz,
  exit_price numeric,
  qty numeric not null,
  pnl numeric,
  pnl_pct numeric,
  exit_reason text,
  confidence numeric,
  market_regime text,
  indicators jsonb,
  created_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.backtest_trades TO authenticated;
GRANT ALL ON public.backtest_trades TO service_role;
ALTER TABLE public.backtest_trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trades" ON public.backtest_trades FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX backtest_trades_run_idx ON public.backtest_trades(run_id);
