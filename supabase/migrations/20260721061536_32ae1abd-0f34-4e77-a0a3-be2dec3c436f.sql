
-- Capital Management: ledger, allocations, policy
CREATE TABLE public.capital_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('deposit','withdrawal','fee','adjustment','realized_pnl')),
  amount_usd NUMERIC(20,2) NOT NULL,
  note TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_ledger TO authenticated;
GRANT ALL ON public.capital_ledger TO service_role;
ALTER TABLE public.capital_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own ledger" ON public.capital_ledger FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX capital_ledger_user_time ON public.capital_ledger(user_id, occurred_at DESC);

CREATE TABLE public.capital_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  target_pct NUMERIC(5,2) NOT NULL CHECK (target_pct >= 0 AND target_pct <= 100),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, bucket)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_allocations TO authenticated;
GRANT ALL ON public.capital_allocations TO service_role;
ALTER TABLE public.capital_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own alloc" ON public.capital_allocations FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);

CREATE TABLE public.capital_policy (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  cash_reserve_pct NUMERIC(5,2) NOT NULL DEFAULT 20 CHECK (cash_reserve_pct >= 0 AND cash_reserve_pct <= 100),
  compounding_mode TEXT NOT NULL DEFAULT 'reinvest' CHECK (compounding_mode IN ('reinvest','fixed','withdraw_profits')),
  fixed_base_usd NUMERIC(20,2) NOT NULL DEFAULT 0,
  profit_withdraw_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (profit_withdraw_pct >= 0 AND profit_withdraw_pct <= 100),
  scale_up_threshold_pct NUMERIC(6,2) NOT NULL DEFAULT 10,
  scale_down_drawdown_pct NUMERIC(6,2) NOT NULL DEFAULT 8,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.capital_policy TO authenticated;
GRANT ALL ON public.capital_policy TO service_role;
ALTER TABLE public.capital_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own policy" ON public.capital_policy FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER capital_allocations_touch BEFORE UPDATE ON public.capital_allocations FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER capital_policy_touch BEFORE UPDATE ON public.capital_policy FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
