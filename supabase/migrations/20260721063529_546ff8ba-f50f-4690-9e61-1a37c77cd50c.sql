
-- Slice: AI Performance Validation & Live Optimization Engine

-- Trade self-review lessons
CREATE TABLE public.trade_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  journal_id uuid,
  symbol text,
  strategy_id text,
  regime text,
  confidence numeric,
  realized_pnl numeric,
  outcome text,
  success_factors text,
  failure_factors text,
  confidence_accuracy text,
  risk_appropriateness text,
  market_condition_change text,
  lessons text,
  ai_model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trade_reviews TO authenticated;
GRANT ALL ON public.trade_reviews TO service_role;
ALTER TABLE public.trade_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own trade_reviews" ON public.trade_reviews FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX idx_trade_reviews_user ON public.trade_reviews(user_id, created_at DESC);

-- Strategy health scores over time
CREATE TABLE public.strategy_health_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  strategy_id text NOT NULL,
  score numeric NOT NULL,
  classification text NOT NULL,
  profitability numeric,
  stability numeric,
  drawdown numeric,
  sharpe numeric,
  recent_perf numeric,
  regime_fit numeric,
  execution_quality numeric,
  sample_size int,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.strategy_health_scores TO authenticated;
GRANT ALL ON public.strategy_health_scores TO service_role;
ALTER TABLE public.strategy_health_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own strat_health" ON public.strategy_health_scores FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX idx_strat_health_user ON public.strategy_health_scores(user_id, strategy_id, created_at DESC);

-- Optimization recommendations (require manual approval)
CREATE TABLE public.optimization_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  target text,
  title text NOT NULL,
  rationale text NOT NULL,
  suggested_change jsonb NOT NULL,
  evidence jsonb,
  severity text NOT NULL DEFAULT 'info',
  status text NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  rejected_at timestamptz,
  applied_at timestamptz,
  reviewer_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.optimization_recommendations TO authenticated;
GRANT ALL ON public.optimization_recommendations TO service_role;
ALTER TABLE public.optimization_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own opt_recs" ON public.optimization_recommendations FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX idx_opt_recs_user ON public.optimization_recommendations(user_id, status, created_at DESC);

-- Model drift monitoring snapshots
CREATE TABLE public.model_drift_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model text NOT NULL,
  window_days int NOT NULL,
  sample_size int NOT NULL,
  accuracy numeric,
  brier numeric,
  calibration_error numeric,
  accuracy_delta numeric,
  distribution_shift numeric,
  drift_flag boolean NOT NULL DEFAULT false,
  drift_reason text,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_drift_snapshots TO authenticated;
GRANT ALL ON public.model_drift_snapshots TO service_role;
ALTER TABLE public.model_drift_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own model_drift" ON public.model_drift_snapshots FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX idx_model_drift_user ON public.model_drift_snapshots(user_id, model, created_at DESC);

-- Audit trail for approvals
CREATE TABLE public.recommendation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recommendation_id uuid NOT NULL,
  action text NOT NULL,
  note text,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recommendation_audit TO authenticated;
GRANT ALL ON public.recommendation_audit TO service_role;
ALTER TABLE public.recommendation_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rec_audit" ON public.recommendation_audit FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX idx_rec_audit_user ON public.recommendation_audit(user_id, created_at DESC);
