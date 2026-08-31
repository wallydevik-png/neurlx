-- 1. Confirmation secret must never be readable by the user's own session.
REVOKE SELECT ON public.vault_withdrawals FROM authenticated;
GRANT SELECT (id, user_id, asset, amount, destination, status, expires_at,
              signature, error, created_at, updated_at)
  ON public.vault_withdrawals TO authenticated;

ALTER TABLE public.vault_withdrawals
  ADD COLUMN IF NOT EXISTS code_channel text NOT NULL DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS code_sent_to text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- 2. Per-user withdrawal policy (daily caps + new-address cooldown).
CREATE TABLE public.vault_withdrawal_policy (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_limit_sol numeric NOT NULL DEFAULT 2,
  daily_limit_usdc numeric NOT NULL DEFAULT 500,
  new_address_cooldown_minutes int NOT NULL DEFAULT 1440,
  pending_daily_limit_sol numeric,
  pending_daily_limit_usdc numeric,
  pending_cooldown_minutes int,
  pending_effective_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.vault_withdrawal_policy TO authenticated;
GRANT ALL ON public.vault_withdrawal_policy TO service_role;
ALTER TABLE public.vault_withdrawal_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own withdrawal policy" ON public.vault_withdrawal_policy
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER vault_withdrawal_policy_touch BEFORE UPDATE ON public.vault_withdrawal_policy
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 3. Known withdrawal destinations, with a first-use cooldown.
CREATE TABLE public.vault_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  address text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  unlocks_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, address)
);
CREATE INDEX vault_destinations_user_idx ON public.vault_destinations (user_id, unlocks_at);
GRANT SELECT ON public.vault_destinations TO authenticated;
GRANT ALL ON public.vault_destinations TO service_role;
ALTER TABLE public.vault_destinations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own vault destinations" ON public.vault_destinations
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER vault_destinations_touch BEFORE UPDATE ON public.vault_destinations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();