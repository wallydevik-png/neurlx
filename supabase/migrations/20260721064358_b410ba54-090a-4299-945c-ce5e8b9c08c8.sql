
CREATE TABLE public.readiness_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  overall_score NUMERIC(5,2) NOT NULL,
  tier TEXT NOT NULL,
  capital_tier TEXT NOT NULL,
  category_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.readiness_snapshots TO authenticated;
GRANT ALL ON public.readiness_snapshots TO service_role;
ALTER TABLE public.readiness_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "readiness_snapshots_owner_all" ON public.readiness_snapshots FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_readiness_snapshots_user_created ON public.readiness_snapshots(user_id, created_at DESC);

CREATE TABLE public.deployment_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  actor TEXT NOT NULL DEFAULT 'user',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.deployment_history TO authenticated;
GRANT ALL ON public.deployment_history TO service_role;
ALTER TABLE public.deployment_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deployment_history_owner_all" ON public.deployment_history FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_deployment_history_user_created ON public.deployment_history(user_id, created_at DESC);

CREATE TABLE public.configuration_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  automation JSONB,
  risk JSONB,
  capital_policy JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.configuration_snapshots TO authenticated;
GRANT ALL ON public.configuration_snapshots TO service_role;
ALTER TABLE public.configuration_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "configuration_snapshots_owner_all" ON public.configuration_snapshots FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_configuration_snapshots_user_created ON public.configuration_snapshots(user_id, created_at DESC);

CREATE TABLE public.approval_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  entity_ref TEXT,
  decision TEXT NOT NULL,
  rationale TEXT,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.approval_records TO authenticated;
GRANT ALL ON public.approval_records TO service_role;
ALTER TABLE public.approval_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "approval_records_owner_all" ON public.approval_records FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_approval_records_user_created ON public.approval_records(user_id, created_at DESC);

CREATE TABLE public.risk_acknowledgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  version TEXT NOT NULL,
  text_hash TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, kind, version)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.risk_acknowledgments TO authenticated;
GRANT ALL ON public.risk_acknowledgments TO service_role;
ALTER TABLE public.risk_acknowledgments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "risk_acknowledgments_owner_all" ON public.risk_acknowledgments FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.production_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_checklist_items TO authenticated;
GRANT ALL ON public.production_checklist_items TO service_role;
ALTER TABLE public.production_checklist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "production_checklist_items_owner_all" ON public.production_checklist_items FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.audit_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  summary_md TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_reports TO authenticated;
GRANT ALL ON public.audit_reports TO service_role;
ALTER TABLE public.audit_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_reports_owner_all" ON public.audit_reports FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_audit_reports_user_period ON public.audit_reports(user_id, period, created_at DESC);

CREATE TABLE public.capital_scale_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  current_allocation NUMERIC(20,8),
  suggested_allocation NUMERIC(20,8),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_scale_recommendations TO authenticated;
GRANT ALL ON public.capital_scale_recommendations TO service_role;
ALTER TABLE public.capital_scale_recommendations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "capital_scale_recommendations_owner_all" ON public.capital_scale_recommendations FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_capital_scale_user_created ON public.capital_scale_recommendations(user_id, created_at DESC);

CREATE TABLE public.emergency_check_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  results JSONB NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.emergency_check_runs TO authenticated;
GRANT ALL ON public.emergency_check_runs TO service_role;
ALTER TABLE public.emergency_check_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "emergency_check_runs_owner_all" ON public.emergency_check_runs FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_emergency_check_user_created ON public.emergency_check_runs(user_id, created_at DESC);
