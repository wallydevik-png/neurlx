ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS trade_volume_mode text NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS fixed_trade_volume numeric NOT NULL DEFAULT 0.01;

ALTER TABLE public.automation_settings
  DROP CONSTRAINT IF EXISTS automation_settings_trade_volume_mode_check;
ALTER TABLE public.automation_settings
  ADD CONSTRAINT automation_settings_trade_volume_mode_check
  CHECK (trade_volume_mode IN ('auto', 'fixed'));