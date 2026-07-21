
CREATE TABLE public.research_hypotheses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT '1h',
  dsl JSONB NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validated','rejected','promoted')),
  last_metrics JSONB,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX research_hypotheses_user_idx ON public.research_hypotheses(user_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.research_hypotheses TO authenticated;
GRANT ALL ON public.research_hypotheses TO service_role;
ALTER TABLE public.research_hypotheses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own hypotheses" ON public.research_hypotheses FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER
  LANGUAGE plpgsql SET search_path = public AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER research_hypotheses_updated
  BEFORE UPDATE ON public.research_hypotheses
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
