CREATE TABLE public.vault_reservations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  amount_sol NUMERIC NOT NULL CHECK (amount_sol > 0),
  purpose TEXT NOT NULL DEFAULT 'trade',
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX vault_reservations_active_idx ON public.vault_reservations (user_id, status, expires_at);
GRANT SELECT ON public.vault_reservations TO authenticated;
GRANT ALL ON public.vault_reservations TO service_role;
ALTER TABLE public.vault_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own vault reservations" ON public.vault_reservations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER vault_reservations_touch BEFORE UPDATE ON public.vault_reservations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.vault_deposits (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  signature TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'SOL',
  amount NUMERIC NOT NULL,
  slot BIGINT,
  block_time TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, signature, asset)
);
CREATE INDEX vault_deposits_user_idx ON public.vault_deposits (user_id, confirmed_at DESC);
GRANT SELECT ON public.vault_deposits TO authenticated;
GRANT ALL ON public.vault_deposits TO service_role;
ALTER TABLE public.vault_deposits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own vault deposits" ON public.vault_deposits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.claim_vault_funds(
  _user_id UUID, _amount NUMERIC, _spendable NUMERIC,
  _purpose TEXT DEFAULT 'trade', _reference TEXT DEFAULT NULL
) RETURNS TABLE (id UUID, granted BOOLEAN, reserved NUMERIC, available NUMERIC)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _reserved NUMERIC;
  _avail NUMERIC;
  _new UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('vault_funds:' || _user_id::text));

  UPDATE public.vault_reservations
     SET status = 'expired', released_at = now()
   WHERE user_id = _user_id AND status = 'active' AND expires_at < now();

  SELECT COALESCE(SUM(amount_sol), 0) INTO _reserved
    FROM public.vault_reservations
   WHERE user_id = _user_id AND status = 'active';

  _avail := _spendable - _reserved;

  IF _amount > _avail THEN
    RETURN QUERY SELECT NULL::uuid, false, _reserved, _avail;
    RETURN;
  END IF;

  INSERT INTO public.vault_reservations (user_id, amount_sol, purpose, reference)
  VALUES (_user_id, _amount, _purpose, _reference)
  RETURNING public.vault_reservations.id INTO _new;

  RETURN QUERY SELECT _new, true, _reserved + _amount, _avail - _amount;
END; $$;

CREATE OR REPLACE FUNCTION public.release_vault_funds(
  _user_id UUID, _reservation_id UUID, _status TEXT DEFAULT 'released'
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _rows INT;
BEGIN
  UPDATE public.vault_reservations
     SET status = CASE WHEN _status IN ('released','consumed') THEN _status ELSE 'released' END,
         released_at = now()
   WHERE id = _reservation_id AND user_id = _user_id AND status = 'active';
  GET DIAGNOSTICS _rows = ROW_COUNT;
  RETURN _rows = 1;
END; $$;

REVOKE ALL ON FUNCTION public.claim_vault_funds(UUID, NUMERIC, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_vault_funds(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_vault_funds(UUID, NUMERIC, NUMERIC, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_vault_funds(UUID, UUID, TEXT) TO service_role;