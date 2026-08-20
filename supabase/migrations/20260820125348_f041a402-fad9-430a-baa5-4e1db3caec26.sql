ALTER TABLE public.autonomous_runs
  ADD COLUMN IF NOT EXISTS signals_deferred integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS signals_failed integer NOT NULL DEFAULT 0;