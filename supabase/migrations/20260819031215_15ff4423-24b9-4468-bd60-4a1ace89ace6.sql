-- Roles (admin gating for the wallet vault)
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin','user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read own roles" ON public.user_roles;
CREATE POLICY "read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- Make the first existing account the admin so the vault is reachable.
INSERT INTO public.user_roles (user_id, role)
SELECT id, 'admin'::public.app_role FROM auth.users ORDER BY created_at ASC LIMIT 1
ON CONFLICT DO NOTHING;

-- Memecoin sniper: settings
CREATE TABLE IF NOT EXISTS public.memecoin_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  autotrade boolean NOT NULL DEFAULT false,
  buy_amount_sol numeric NOT NULL DEFAULT 0.05,
  max_open_positions integer NOT NULL DEFAULT 3,
  take_profit_pct numeric NOT NULL DEFAULT 60,
  stop_loss_pct numeric NOT NULL DEFAULT 25,
  trailing_stop_pct numeric NOT NULL DEFAULT 20,
  min_liquidity_usd numeric NOT NULL DEFAULT 25000,
  min_score integer NOT NULL DEFAULT 70,
  slippage_bps integer NOT NULL DEFAULT 300,
  max_daily_loss_sol numeric NOT NULL DEFAULT 0.25,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memecoin_settings TO authenticated;
GRANT ALL ON public.memecoin_settings TO service_role;
ALTER TABLE public.memecoin_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own memecoin settings" ON public.memecoin_settings;
CREATE POLICY "own memecoin settings" ON public.memecoin_settings FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER memecoin_settings_touch BEFORE UPDATE ON public.memecoin_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Trading wallet: public key visible to the owner, secret key encrypted at rest
CREATE TABLE IF NOT EXISTS public.memecoin_wallets (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  encrypted_secret text,
  phantom_address text,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memecoin_wallets TO authenticated;
GRANT ALL ON public.memecoin_wallets TO service_role;
ALTER TABLE public.memecoin_wallets ENABLE ROW LEVEL SECURITY;
-- Deliberately no direct table access for end users: the encrypted secret is
-- only ever handled by server code running as the service role.
DROP POLICY IF EXISTS "admins read own wallet row" ON public.memecoin_wallets;
CREATE POLICY "admins read own wallet row" ON public.memecoin_wallets FOR SELECT TO authenticated
  USING (auth.uid() = user_id AND public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER memecoin_wallets_touch BEFORE UPDATE ON public.memecoin_wallets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Scanned memecoin candidates
CREATE TABLE IF NOT EXISTS public.memecoin_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mint text NOT NULL,
  symbol text NOT NULL,
  name text,
  score integer NOT NULL,
  verdict text NOT NULL DEFAULT 'watch',
  price_usd numeric,
  liquidity_usd numeric,
  volume_24h_usd numeric,
  fdv_usd numeric,
  age_minutes integer,
  change_5m numeric,
  change_1h numeric,
  buy_sell_ratio numeric,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_thesis text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memecoin_signals_created_idx ON public.memecoin_signals (created_at DESC);
GRANT SELECT ON public.memecoin_signals TO authenticated;
GRANT ALL ON public.memecoin_signals TO service_role;
ALTER TABLE public.memecoin_signals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signals readable by signed-in users" ON public.memecoin_signals;
CREATE POLICY "signals readable by signed-in users" ON public.memecoin_signals FOR SELECT TO authenticated USING (true);

-- Executed on-chain positions
CREATE TABLE IF NOT EXISTS public.memecoin_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mint text NOT NULL,
  symbol text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  amount_sol numeric NOT NULL,
  tokens numeric,
  entry_price_usd numeric,
  exit_price_usd numeric,
  peak_price_usd numeric,
  pnl_sol numeric,
  pnl_pct numeric,
  entry_tx text,
  exit_tx text,
  score integer,
  exit_reason text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS memecoin_positions_user_idx ON public.memecoin_positions (user_id, status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.memecoin_positions TO authenticated;
GRANT ALL ON public.memecoin_positions TO service_role;
ALTER TABLE public.memecoin_positions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own memecoin positions" ON public.memecoin_positions;
CREATE POLICY "own memecoin positions" ON public.memecoin_positions FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);