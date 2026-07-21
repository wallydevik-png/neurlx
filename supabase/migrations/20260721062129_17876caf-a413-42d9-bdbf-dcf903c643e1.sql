
CREATE TABLE public.asset_universe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  asset_class TEXT NOT NULL CHECK (asset_class IN ('crypto_spot','crypto_perp','equity','forex','commodity','index')),
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  exchange TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  tick_size NUMERIC(20,10) NOT NULL DEFAULT 0.01,
  min_notional NUMERIC(20,4) NOT NULL DEFAULT 10,
  leverage_max NUMERIC(6,2) NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(connector_id, symbol)
);
GRANT SELECT ON public.asset_universe TO authenticated;
GRANT ALL ON public.asset_universe TO service_role;
ALTER TABLE public.asset_universe ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read universe" ON public.asset_universe FOR SELECT TO authenticated USING (true);

CREATE TABLE public.user_watchlists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instrument_id UUID NOT NULL REFERENCES public.asset_universe(id) ON DELETE CASCADE,
  priority INT NOT NULL DEFAULT 0,
  notes TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, instrument_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_watchlists TO authenticated;
GRANT ALL ON public.user_watchlists TO service_role;
ALTER TABLE public.user_watchlists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own watch" ON public.user_watchlists FOR ALL USING (auth.uid()=user_id) WITH CHECK (auth.uid()=user_id);
CREATE INDEX watch_user ON public.user_watchlists(user_id);

-- Seed core instruments across asset classes
INSERT INTO public.asset_universe (symbol, asset_class, base, quote, exchange, connector_id, tick_size, min_notional, leverage_max) VALUES
  ('BTCUSDT','crypto_spot','BTC','USDT','Binance','binance',0.01,10,1),
  ('ETHUSDT','crypto_spot','ETH','USDT','Binance','binance',0.01,10,1),
  ('SOLUSDT','crypto_spot','SOL','USDT','Binance','binance',0.01,10,1),
  ('BNBUSDT','crypto_spot','BNB','USDT','Binance','binance',0.01,10,1),
  ('XRPUSDT','crypto_spot','XRP','USDT','Binance','binance',0.0001,10,1),
  ('BTC-PERP','crypto_perp','BTC','USDT','Binance Futures','binance',0.1,10,20),
  ('ETH-PERP','crypto_perp','ETH','USDT','Binance Futures','binance',0.01,10,20),
  ('SOL-PERP','crypto_perp','SOL','USDT','Binance Futures','binance',0.001,10,20),
  ('AAPL','equity','AAPL','USD','NASDAQ','paper',0.01,1,1),
  ('MSFT','equity','MSFT','USD','NASDAQ','paper',0.01,1,1),
  ('NVDA','equity','NVDA','USD','NASDAQ','paper',0.01,1,1),
  ('SPY','equity','SPY','USD','NYSE','paper',0.01,1,1),
  ('TSLA','equity','TSLA','USD','NASDAQ','paper',0.01,1,1),
  ('EURUSD','forex','EUR','USD','FX','paper',0.00001,1,30),
  ('GBPUSD','forex','GBP','USD','FX','paper',0.00001,1,30),
  ('USDJPY','forex','USD','JPY','FX','paper',0.001,1,30),
  ('XAUUSD','commodity','XAU','USD','Metals','paper',0.01,1,10),
  ('WTI','commodity','WTI','USD','Energy','paper',0.01,1,10),
  ('SPX','index','SPX','USD','CBOE','paper',0.1,1,5),
  ('NDX','index','NDX','USD','NASDAQ','paper',0.1,1,5);
