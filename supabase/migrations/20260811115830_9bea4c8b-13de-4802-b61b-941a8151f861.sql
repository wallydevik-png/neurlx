ALTER TABLE public.exchange_connections
ADD COLUMN live_equity_high_water numeric NOT NULL DEFAULT 0
CHECK (live_equity_high_water >= 0);