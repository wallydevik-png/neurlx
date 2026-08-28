CREATE TABLE public.vault_wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key text NOT NULL UNIQUE,
  encrypted_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.vault_wallets TO service_role;
ALTER TABLE public.vault_wallets ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER vault_wallets_touch BEFORE UPDATE ON public.vault_wallets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.vault_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  asset text NOT NULL DEFAULT 'SOL',
  amount numeric NOT NULL,
  signature text,
  status text NOT NULL DEFAULT 'confirmed',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_transactions_user_idx ON public.vault_transactions (user_id, created_at DESC);
GRANT SELECT ON public.vault_transactions TO authenticated;
GRANT ALL ON public.vault_transactions TO service_role;
ALTER TABLE public.vault_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own vault transactions" ON public.vault_transactions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE TABLE public.vault_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  asset text NOT NULL DEFAULT 'SOL',
  amount numeric NOT NULL,
  destination text NOT NULL,
  status text NOT NULL DEFAULT 'pending_confirmation',
  code_hash text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  signature text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vault_withdrawals_user_idx ON public.vault_withdrawals (user_id, created_at DESC);
GRANT SELECT ON public.vault_withdrawals TO authenticated;
GRANT ALL ON public.vault_withdrawals TO service_role;
ALTER TABLE public.vault_withdrawals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own withdrawals" ON public.vault_withdrawals
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE TRIGGER vault_withdrawals_touch BEFORE UPDATE ON public.vault_withdrawals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();