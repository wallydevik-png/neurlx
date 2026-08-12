CREATE TABLE public.rejection_stage_stats (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  stage text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, stage)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rejection_stage_stats TO authenticated;
GRANT ALL ON public.rejection_stage_stats TO service_role;
ALTER TABLE public.rejection_stage_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rejection_stage_stats_owner_all" ON public.rejection_stage_stats
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX rejection_stage_stats_user_day_idx ON public.rejection_stage_stats (user_id, day DESC);