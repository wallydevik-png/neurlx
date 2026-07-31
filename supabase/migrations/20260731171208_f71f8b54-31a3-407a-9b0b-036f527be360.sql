
CREATE TABLE public.portfolio_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  signal_id uuid,
  strategy_id uuid,
  symbol text NOT NULL,
  side text NOT NULL,
  score numeric NOT NULL DEFAULT 0,
  allocation_pct numeric NOT NULL DEFAULT 0,
  risk_pct numeric NOT NULL DEFAULT 0,
  approved boolean NOT NULL DEFAULT false,
  reject_reason text,
  stage text NOT NULL DEFAULT 'portfolio_manager',
  portfolio_mode text NOT NULL DEFAULT 'normal',
  regime text,
  health_score numeric,
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_decisions TO authenticated;
GRANT ALL ON public.portfolio_decisions TO service_role;
ALTER TABLE public.portfolio_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own portfolio decisions" ON public.portfolio_decisions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_pd_user_created ON public.portfolio_decisions (user_id, created_at DESC);

CREATE TABLE public.portfolio_health_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  health_score numeric NOT NULL DEFAULT 0,
  heat numeric NOT NULL DEFAULT 0,
  risk_concentration numeric NOT NULL DEFAULT 0,
  capital_utilization numeric NOT NULL DEFAULT 0,
  correlation_score numeric NOT NULL DEFAULT 0,
  volatility numeric NOT NULL DEFAULT 0,
  expected_drawdown numeric NOT NULL DEFAULT 0,
  diversification_score numeric NOT NULL DEFAULT 0,
  recovery_factor numeric NOT NULL DEFAULT 0,
  expected_monthly_return numeric NOT NULL DEFAULT 0,
  worst_case_projection numeric NOT NULL DEFAULT 0,
  portfolio_mode text NOT NULL DEFAULT 'normal',
  regime text,
  sector_exposure jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.portfolio_health_snapshots TO authenticated;
GRANT ALL ON public.portfolio_health_snapshots TO service_role;
ALTER TABLE public.portfolio_health_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own health snapshots" ON public.portfolio_health_snapshots FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_phs_user_created ON public.portfolio_health_snapshots (user_id, created_at DESC);

CREATE TABLE public.market_regime_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  regime text NOT NULL,
  label text,
  confidence numeric NOT NULL DEFAULT 0,
  tradable boolean NOT NULL DEFAULT true,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.market_regime_snapshots TO authenticated;
GRANT ALL ON public.market_regime_snapshots TO service_role;
ALTER TABLE public.market_regime_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own regime snapshots" ON public.market_regime_snapshots FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_mrs_user_created ON public.market_regime_snapshots (user_id, created_at DESC);

CREATE TABLE public.trade_quality_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  position_id uuid,
  strategy_id uuid,
  symbol text NOT NULL,
  execution_quality numeric NOT NULL DEFAULT 0,
  entry_timing numeric NOT NULL DEFAULT 0,
  exit_timing numeric NOT NULL DEFAULT 0,
  risk_quality numeric NOT NULL DEFAULT 0,
  size_quality numeric NOT NULL DEFAULT 0,
  psychology numeric NOT NULL DEFAULT 0,
  ai_confidence numeric NOT NULL DEFAULT 0,
  overall numeric NOT NULL DEFAULT 0,
  grade text NOT NULL DEFAULT 'C',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_quality_scores TO authenticated;
GRANT ALL ON public.trade_quality_scores TO service_role;
ALTER TABLE public.trade_quality_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trade quality" ON public.trade_quality_scores FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE UNIQUE INDEX idx_tqs_position ON public.trade_quality_scores (position_id);

CREATE TABLE public.capital_engine_params (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'shadow',
  trades_evaluated integer NOT NULL DEFAULT 0,
  optimal_allocation_pct numeric,
  optimal_stop_atr_mult numeric,
  optimal_tp_r_multiple numeric,
  optimal_holding_minutes integer,
  optimal_trailing_pct numeric,
  strategy_weights jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_engine_params TO authenticated;
GRANT ALL ON public.capital_engine_params TO service_role;
ALTER TABLE public.capital_engine_params ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own capital params" ON public.capital_engine_params FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER trg_cep_touch BEFORE UPDATE ON public.capital_engine_params
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS pm_min_score numeric NOT NULL DEFAULT 75,
  ADD COLUMN IF NOT EXISTS pm_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sector_limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS max_crypto_beta numeric NOT NULL DEFAULT 6,
  ADD COLUMN IF NOT EXISTS portfolio_mode text NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS aggressive_mode_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS overtrading_window_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS overtrading_max_trades integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS overtrading_min_score numeric NOT NULL DEFAULT 95;
