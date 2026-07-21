export const BASE_PRICES: Record<string, number> = {
  "BTC-USD": 68000,
  "ETH-USD": 3500,
  "SOL-USD": 175,
  "ADA-USD": 0.45,
  "AVAX-USD": 32,
  "LINK-USD": 15,
  "DOGE-USD": 0.14,
  "MATIC-USD": 0.55,
  AAPL: 225,
  TSLA: 240,
  NVDA: 135,
};

export const SUPPORTED_SYMBOLS = Object.keys(BASE_PRICES);

export function listSupportedSymbols(): string[] {
  return SUPPORTED_SYMBOLS;
}