
ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS risk_per_trade_pct numeric NOT NULL DEFAULT 0.005,
  ADD COLUMN IF NOT EXISTS max_daily_drawdown_pct numeric NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS max_weekly_drawdown_pct numeric NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS max_account_drawdown_pct numeric NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS max_spread_bps numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS min_risk_reward numeric NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS max_risk_reward numeric NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS news_filter_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS mtf_confirmation_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS capital_preservation_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS equity_high_water numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weekly_lock_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drawdown_lock_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_pause_until timestamptz,
  ADD COLUMN IF NOT EXISTS max_correlated_risk_pct numeric NOT NULL DEFAULT 2;

CREATE TABLE IF NOT EXISTS public.strategy_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  strategy text NOT NULL,
  weight numeric NOT NULL DEFAULT 1,
  profit_factor numeric,
  win_rate numeric,
  expectancy numeric,
  sample_size integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, strategy)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_weights TO authenticated;
GRANT ALL ON public.strategy_weights TO service_role;
ALTER TABLE public.strategy_weights ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own strategy weights" ON public.strategy_weights
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.learning_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  trades_evaluated integer NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  win_rate numeric,
  profit_factor numeric,
  sharpe numeric,
  sortino numeric,
  expectancy numeric,
  avg_r numeric,
  max_drawdown_pct numeric,
  adjustments jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.learning_evaluations TO authenticated;
GRANT ALL ON public.learning_evaluations TO service_role;
ALTER TABLE public.learning_evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own learning evaluations" ON public.learning_evaluations
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
