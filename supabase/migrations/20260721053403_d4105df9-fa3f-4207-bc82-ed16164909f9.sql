CREATE TABLE public.webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL DEFAULT 'unknown',
  backed_up BOOLEAN NOT NULL DEFAULT false,
  transports TEXT[] NOT NULL DEFAULT '{}',
  nickname TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT true
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.webauthn_credentials TO authenticated;
GRANT ALL ON public.webauthn_credentials TO service_role;
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own webauthn credentials" ON public.webauthn_credentials FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE TABLE public.webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'registration' CHECK (purpose IN ('registration','authentication')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);
GRANT SELECT, INSERT, DELETE ON public.webauthn_challenges TO authenticated;
GRANT ALL ON public.webauthn_challenges TO service_role;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own webauthn challenges" ON public.webauthn_challenges FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
