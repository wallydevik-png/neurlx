ALTER TABLE public.exchange_connections
  ADD COLUMN IF NOT EXISTS last_test_report jsonb,
  ADD COLUMN IF NOT EXISTS last_test_at timestamptz;