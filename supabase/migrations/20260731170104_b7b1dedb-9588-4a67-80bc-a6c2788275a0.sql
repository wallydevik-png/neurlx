
ALTER TABLE public.strategies
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'shadow',
  ADD COLUMN IF NOT EXISTS score numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS allocation_risk_pct numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS model_version text,
  ADD COLUMN IF NOT EXISTS drift_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS drift_at timestamptz,
  ADD COLUMN IF NOT EXISTS state_reason text,
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS consecutive_losses integer NOT NULL DEFAULT 0;

ALTER TABLE public.shadow_trades
  ADD COLUMN IF NOT EXISTS r_multiple numeric,
  ADD COLUMN IF NOT EXISTS slippage numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spread numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latency_ms integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'shadow',
  ADD COLUMN IF NOT EXISTS model_version text,
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS public.strategy_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id uuid REFERENCES public.strategies(id) ON DELETE CASCADE,
  from_state text NOT NULL,
  to_state text NOT NULL,
  reason text NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_lifecycle_events TO authenticated;
GRANT ALL ON public.strategy_lifecycle_events TO service_role;
ALTER TABLE public.strategy_lifecycle_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own lifecycle events" ON public.strategy_lifecycle_events
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_user ON public.strategy_lifecycle_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.strategy_regime_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  regime text NOT NULL,
  trades integer NOT NULL DEFAULT 0,
  wins integer NOT NULL DEFAULT 0,
  profit_factor numeric NOT NULL DEFAULT 0,
  win_rate numeric NOT NULL DEFAULT 0,
  expectancy numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (strategy_id, regime)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_regime_stats TO authenticated;
GRANT ALL ON public.strategy_regime_stats TO service_role;
ALTER TABLE public.strategy_regime_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own regime stats" ON public.strategy_regime_stats
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER strategy_regime_stats_touch BEFORE UPDATE ON public.strategy_regime_stats
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id uuid REFERENCES public.strategies(id) ON DELETE CASCADE,
  version text NOT NULL,
  state text NOT NULL DEFAULT 'shadow',
  training_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_importance jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_candidate boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_versions TO authenticated;
GRANT ALL ON public.model_versions TO service_role;
ALTER TABLE public.model_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own model versions" ON public.model_versions
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER model_versions_touch BEFORE UPDATE ON public.model_versions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE IF NOT EXISTS public.strategy_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id uuid NOT NULL REFERENCES public.strategies(id) ON DELETE CASCADE,
  state text NOT NULL,
  score numeric NOT NULL DEFAULT 0,
  windows jsonb NOT NULL DEFAULT '{}'::jsonb,
  walk_forward jsonb NOT NULL DEFAULT '{}'::jsonb,
  regime_stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  drift jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_validation_runs TO authenticated;
GRANT ALL ON public.strategy_validation_runs TO service_role;
ALTER TABLE public.strategy_validation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own validation runs" ON public.strategy_validation_runs
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS idx_validation_runs ON public.strategy_validation_runs(user_id, strategy_id, created_at DESC);
