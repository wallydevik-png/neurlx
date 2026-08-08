// Asset-class classification for the tradable universe.
//
// The autonomous scan is restricted to instrument families the engine's
// indicator/regime models are actually calibrated for: crypto, major forex
// and index CFDs. Individual equities (single stocks, international share
// CFDs such as `BKNGNAS`, `AAPL.us`, `SAP.de`) are dropped from the scan
// entirely instead of being patched symbol-name-by-symbol.

export type AssetClass = "crypto" | "forex" | "index" | "metal" | "energy" | "equity" | "unknown";

/** Currencies that count as "major forex" for the scan universe. */
const MAJOR_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD",
]);

const CRYPTO_BASES = new Set([
  "BTC", "XBT", "ETH", "SOL", "ADA", "AVAX", "LINK", "DOGE", "MATIC", "POL",
  "XRP", "TRX", "LTC", "BNB", "DOT", "ATOM", "NEAR", "FIL", "ETC", "UNI",
  "AAVE", "ALGO", "APT", "ARB", "OP", "SUI", "SHIB", "PEPE", "BCH", "XLM",
  "ICP", "INJ", "CRV", "LDO", "MKR", "SAND", "MANA", "AXS", "GRT", "SNX",
  "COMP", "ENJ", "CHZ", "EOS", "XMR", "ZEC", "DASH", "NEO", "VET", "THETA",
  "FTM", "RUNE", "KAS", "TON", "TIA", "SEI", "STX", "RNDR", "IMX", "HBAR",
  "EGLD", "FLOW", "GALA", "KSM", "ONE", "QNT", "ROSE", "WLD", "YFI", "ZIL",
]);

const STABLE_QUOTES = new Set(["USD", "USDT", "USDC", "BUSD", "DAI", "TUSD", "EUR"]);

const METALS = new Set(["XAU", "XAG", "XPT", "XPD", "GOLD", "SILVER"]);
const ENERGIES = new Set(["WTI", "BRENT", "USOIL", "UKOIL", "XBR", "XTI", "NGAS", "NATGAS"]);

/** Index CFD tickers across common broker naming conventions. */
const INDEX_SYMBOLS = new Set([
  "US30", "US500", "US100", "US2000", "USTEC", "NAS100", "NDX100", "SPX500",
  "SP500", "DJI30", "WS30", "GER30", "GER40", "DE30", "DE40", "DAX40",
  "UK100", "FRA40", "CAC40", "EU50", "STOXX50", "ESP35", "IBEX35", "ITA40",
  "JP225", "JPN225", "NIKKEI", "HK50", "HSI50", "CHINA50", "CN50",
  "AUS200", "AU200", "SUI20", "NETH25", "SWI20", "VIX",
]);

function stripDecorations(raw: string): string {
  // Broker suffixes: BTCUSD.m, EURUSD_raw, US30cash, XAUUSD-ECN
  return raw
    .toUpperCase()
    .replace(/[._-](M|MICRO|RAW|ECN|PRO|C|I|X|STP|SB|CASH|SPOT|R)$/i, "")
    .replace(/(CASH|SPOT)$/i, "")
    .trim();
}

function splitPair(sym: string): [string, string] | null {
  if (sym.includes("-")) {
    const [a, b] = sym.split("-");
    if (a && b) return [a, b];
    return null;
  }
  if (sym.includes("/")) {
    const [a, b] = sym.split("/");
    if (a && b) return [a, b];
    return null;
  }
  if (sym.length === 6) return [sym.slice(0, 3), sym.slice(3)];
  for (const q of ["USDT", "USDC", "USD", "EUR", "JPY", "GBP"]) {
    if (sym.length > q.length && sym.endsWith(q)) return [sym.slice(0, -q.length), q];
  }
  return null;
}

export function classifySymbol(raw: string): AssetClass {
  if (!raw) return "unknown";
  const sym = stripDecorations(raw);
  if (INDEX_SYMBOLS.has(sym)) return "index";
  // Numeric-suffixed index names not in the table (e.g. "NAS100", "JP400")
  if (/^[A-Z]{2,6}\d{2,4}$/.test(sym) && !CRYPTO_BASES.has(sym)) return "index";

  const pair = splitPair(sym);
  if (pair) {
    const [base, quote] = pair;
    if (METALS.has(base)) return "metal";
    if (ENERGIES.has(base)) return "energy";
    if (CRYPTO_BASES.has(base) && STABLE_QUOTES.has(quote)) return "crypto";
    if (MAJOR_CURRENCIES.has(base) && MAJOR_CURRENCIES.has(quote)) return "forex";
    if (STABLE_QUOTES.has(quote)) return "equity"; // e.g. share CFD quoted in USD
    return "unknown";
  }
  if (METALS.has(sym)) return "metal";
  if (ENERGIES.has(sym)) return "energy";
  if (CRYPTO_BASES.has(sym)) return "crypto";
  // Bare alphabetic tickers (AAPL, TSLA, BKNGNAS, SAP) are single equities.
  if (/^[A-Z.]{1,10}$/.test(sym)) return "equity";
  return "unknown";
}

/** Classes the autonomous scan is allowed to trade. */
export const SCAN_ASSET_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  "crypto", "forex", "index",
]);

export function isScannableSymbol(symbol: string): boolean {
  return SCAN_ASSET_CLASSES.has(classifySymbol(symbol));
}

/** Filter a broker/watchlist symbol list down to the scannable universe. */
export function filterScanUniverse(symbols: string[]): string[] {
  return symbols.filter(isScannableSymbol);
}
