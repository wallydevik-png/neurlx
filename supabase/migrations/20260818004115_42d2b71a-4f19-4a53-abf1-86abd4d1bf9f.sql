CREATE UNIQUE INDEX autonomous_runs_one_active_per_user
  ON public.autonomous_runs (user_id)
  WHERE finished_at IS NULL;