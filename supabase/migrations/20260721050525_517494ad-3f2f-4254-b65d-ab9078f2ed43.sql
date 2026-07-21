
ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS autonomous_live_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS autonomous_min_confidence numeric(4,3) NOT NULL DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS autonomous_max_open_positions integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS autonomous_cooldown_seconds integer NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS autonomous_last_run_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS autonomous_default_connection_id uuid REFERENCES public.exchange_connections(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS autonomous_consecutive_losses integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autonomous_max_consecutive_losses integer NOT NULL DEFAULT 3;

CREATE TABLE IF NOT EXISTS public.autonomous_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  signals_scanned integer NOT NULL DEFAULT 0,
  signals_executed integer NOT NULL DEFAULT 0,
  signals_rejected integer NOT NULL DEFAULT 0,
  reject_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  trigger text NOT NULL DEFAULT 'manual',
  live boolean NOT NULL DEFAULT false
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.autonomous_runs TO authenticated;
GRANT ALL ON public.autonomous_runs TO service_role;

ALTER TABLE public.autonomous_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "autonomous_runs_owner_all" ON public.autonomous_runs
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS autonomous_runs_user_started_idx
  ON public.autonomous_runs (user_id, started_at DESC);
