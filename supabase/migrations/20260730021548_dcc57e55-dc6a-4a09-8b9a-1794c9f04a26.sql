ALTER TABLE public.automation_settings
  ADD COLUMN IF NOT EXISTS min_free_margin_pct numeric NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS daily_profit_target numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS margin_pause_active boolean NOT NULL DEFAULT false;

ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS connection_id uuid,
  ADD COLUMN IF NOT EXISTS external_position_id text,
  ADD COLUMN IF NOT EXISTS broker_symbol text,
  ADD COLUMN IF NOT EXISTS used_margin numeric,
  ADD COLUMN IF NOT EXISTS swap numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS commission numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_pnl numeric;

CREATE TABLE IF NOT EXISTS public.broker_trade_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  connection_id uuid,
  order_id uuid,
  position_id uuid,
  venue text NOT NULL DEFAULT 'mt5',
  broker_symbol text,
  requested_symbol text,
  side text,
  volume numeric,
  metaapi_order_id text,
  broker_position_ticket text,
  client_order_id text,
  state text NOT NULL DEFAULT 'open',
  opened_at timestamp with time zone NOT NULL DEFAULT now(),
  closed_at timestamp with time zone,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.broker_trade_tickets TO authenticated;
GRANT ALL ON public.broker_trade_tickets TO service_role;

ALTER TABLE public.broker_trade_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own broker trade tickets"
  ON public.broker_trade_tickets FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS broker_trade_tickets_user_idx
  ON public.broker_trade_tickets (user_id, state, opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS broker_trade_tickets_ticket_idx
  ON public.broker_trade_tickets (user_id, venue, broker_position_ticket)
  WHERE broker_position_ticket IS NOT NULL;

CREATE TRIGGER broker_trade_tickets_touch
  BEFORE UPDATE ON public.broker_trade_tickets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();