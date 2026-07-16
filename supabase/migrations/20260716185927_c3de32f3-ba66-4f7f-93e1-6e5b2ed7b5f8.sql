
-- Market candles: shared cache of OHLCV data across all users.
CREATE TABLE public.market_candles (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL, -- '1m','5m','1h','1d'
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low  NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'synthetic',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (symbol, interval, ts, source)
);
CREATE INDEX market_candles_lookup_idx ON public.market_candles (symbol, interval, ts DESC);

GRANT SELECT ON public.market_candles TO authenticated;
GRANT ALL ON public.market_candles TO service_role;

ALTER TABLE public.market_candles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read market candles"
  ON public.market_candles FOR SELECT TO authenticated USING (true);

-- Extend signals with AI explainability + outcome tracking.
ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS time_horizon TEXT NOT NULL DEFAULT 'intraday',
  ADD COLUMN IF NOT EXISTS risk_level   TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS market_regime TEXT,
  ADD COLUMN IF NOT EXISTS indicators   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS contributions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS risk_factors  JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS outcome_status TEXT,      -- 'hit_tp','hit_sl','pending_eval','expired'
  ADD COLUMN IF NOT EXISTS outcome_pnl_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS evaluated_at TIMESTAMPTZ;

-- side may now be 'buy' | 'sell' | 'wait' — no CHECK to enforce; app validates.
