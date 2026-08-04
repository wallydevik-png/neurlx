// Maps NeurlX internal symbols to real-market data provider tickers.
// Yahoo Finance covers crypto, FX, metals, energies, indices and equities;
// CoinGecko is used for crypto community/social metrics only.

const YAHOO_OVERRIDES: Record<string, string> = {
  "XAU-USD": "GC=F",
  "XAG-USD": "SI=F",
  "WTI-USD": "CL=F",
  "BRENT-USD": "BZ=F",
  US30: "^DJI",
  NAS100: "^NDX",
  SPX500: "^GSPC",
  GER40: "^GDAXI",
  UK100: "^FTSE",
};

const CRYPTO_BASES = new Set([
  "BTC", "ETH", "SOL", "ADA", "AVAX", "LINK", "DOGE",
  "MATIC", "XRP", "TRX", "LTC", "BNB", "DOT",
]);

const FIAT = new Set(["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD"]);

export const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ADA: "cardano",
  AVAX: "avalanche-2", LINK: "chainlink", DOGE: "dogecoin",
  MATIC: "matic-network", XRP: "ripple", TRX: "tron",
  LTC: "litecoin", BNB: "binancecoin", DOT: "polkadot",
};

export function splitPair(symbol: string): { base: string; quote: string } | null {
  const m = symbol.toUpperCase().match(/^([A-Z0-9]{2,6})[-/_]([A-Z]{3})$/);
  return m ? { base: m[1], quote: m[2] } : null;
}

export function isCrypto(symbol: string): boolean {
  const p = splitPair(symbol);
  return !!p && CRYPTO_BASES.has(p.base);
}

export function isForex(symbol: string): boolean {
  const p = splitPair(symbol);
  return !!p && FIAT.has(p.base) && FIAT.has(p.quote);
}

/** Yahoo Finance ticker for a NeurlX symbol, or null if unmapped. */
export function toYahoo(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (YAHOO_OVERRIDES[s]) return YAHOO_OVERRIDES[s];
  const p = splitPair(s);
  if (!p) return /^[A-Z.]{1,6}$/.test(s) ? s : null;  // equity ticker
  if (CRYPTO_BASES.has(p.base)) return `${p.base}-${p.quote}`;
  if (isForex(s)) return `${p.base}${p.quote}=X`;
  return null;
}

export function toCoinGeckoId(symbol: string): string | null {
  const p = splitPair(symbol);
  return p ? (COINGECKO_IDS[p.base] ?? null) : null;
}
