// Tradable universe. MetaTrader connections cover forex, metals, energies,
// indices and crypto CFDs — the connector resolves each of these against the
// broker's real instrument list at execution time (see mt5.server.ts), and any
// pair the broker doesn't offer is skipped instead of submitted.
export const BASE_PRICES: Record<string, number> = {
  // Crypto
  "BTC-USD": 68000,
  "ETH-USD": 3500,
  "SOL-USD": 175,
  "ADA-USD": 0.45,
  "AVAX-USD": 32,
  "LINK-USD": 15,
  "DOGE-USD": 0.14,
  "MATIC-USD": 0.55,
  "XRP-USD": 0.62,
  "TRX-USD": 0.13,
  "LTC-USD": 85,
  "BNB-USD": 590,
  "DOT-USD": 6.5,
  // Meme coins (high beta, scanned with dedicated slots each cycle)
  "SHIB-USD": 0.000022,
  "PEPE-USD": 0.0000095,
  "WIF-USD": 2.1,
  "BONK-USD": 0.000024,
  "FLOKI-USD": 0.00015,
  "BOME-USD": 0.009,
  "POPCAT-USD": 0.85,
  "TURBO-USD": 0.006,

  // Forex majors
  "EUR-USD": 1.085,
  "GBP-USD": 1.27,
  "USD-JPY": 152,
  "USD-CHF": 0.89,
  "AUD-USD": 0.66,
  "NZD-USD": 0.6,
  "USD-CAD": 1.36,
  // Forex crosses
  "EUR-GBP": 0.855,
  "EUR-JPY": 165,
  "GBP-JPY": 193,
  "AUD-JPY": 100,
  "EUR-AUD": 1.64,
  "GBP-CHF": 1.13,
  // Metals & energies
  "XAU-USD": 2350,
  "XAG-USD": 28,
  "WTI-USD": 78,
  "BRENT-USD": 82,
  // Indices (CFD)
  US30: 39000,
  NAS100: 18500,
  SPX500: 5200,
  GER40: 18200,
  UK100: 8200,
  // Equities
  AAPL: 225,
  TSLA: 240,
  NVDA: 135,
};

export const SUPPORTED_SYMBOLS = Object.keys(BASE_PRICES);

export function listSupportedSymbols(): string[] {
  return SUPPORTED_SYMBOLS;
}
