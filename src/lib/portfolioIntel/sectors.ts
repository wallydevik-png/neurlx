// Sector + correlation reference data for the Portfolio Intelligence layer.
// Pure data & helpers — no IO, safe to import anywhere.

export type Sector =
  | "layer1"
  | "layer2"
  | "ai"
  | "defi"
  | "gaming"
  | "meme"
  | "stablecoin"
  | "payments"
  | "equity"
  | "fx"
  | "commodity"
  | "index"
  | "other";

export const SECTOR_LABELS: Record<Sector, string> = {
  layer1: "Layer 1 chains",
  layer2: "Layer 2 / scaling",
  ai: "AI tokens",
  defi: "DeFi",
  gaming: "Gaming / metaverse",
  meme: "Meme coins",
  stablecoin: "Stablecoins",
  payments: "Payments / store of value",
  equity: "Equities",
  fx: "FX majors",
  commodity: "Commodities",
  index: "Indices",
  other: "Other",
};

/** Default maximum share of portfolio risk allowed per sector (percent). */
export const DEFAULT_SECTOR_LIMITS: Record<Sector, number> = {
  layer1: 35, layer2: 20, ai: 20, defi: 20, gaming: 10, meme: 5,
  stablecoin: 10, payments: 40, equity: 40, fx: 50, commodity: 25,
  index: 30, other: 20,
};

const SECTOR_MAP: Record<string, Sector> = {
  BTC: "payments", LTC: "payments", BCH: "payments", XMR: "payments",
  ETH: "layer1", SOL: "layer1", ADA: "layer1", AVAX: "layer1", DOT: "layer1",
  ATOM: "layer1", NEAR: "layer1", APT: "layer1", SUI: "layer1", TRX: "layer1",
  BNB: "layer1", TON: "layer1", ALGO: "layer1", HBAR: "layer1", EGLD: "layer1",
  MATIC: "layer2", ARB: "layer2", OP: "layer2", STRK: "layer2", IMX: "layer2",
  FET: "ai", AGIX: "ai", OCEAN: "ai", RNDR: "ai", TAO: "ai", WLD: "ai", GRT: "ai",
  UNI: "defi", AAVE: "defi", CRV: "defi", MKR: "defi", COMP: "defi", SNX: "defi",
  LDO: "defi", SUSHI: "defi", CAKE: "defi", LINK: "defi", INJ: "defi",
  AXS: "gaming", SAND: "gaming", MANA: "gaming", GALA: "gaming", ENJ: "gaming",
  DOGE: "meme", SHIB: "meme", PEPE: "meme", WIF: "meme", BONK: "meme", FLOKI: "meme",
  USDT: "stablecoin", USDC: "stablecoin", DAI: "stablecoin",
  XAU: "commodity", XAG: "commodity", WTI: "commodity", USOIL: "commodity",
};

const FX_CODES = new Set(["EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD", "USD"]);
const INDEX_CODES = new Set(["US30", "NAS100", "SPX500", "US500", "GER40", "UK100", "JP225"]);

/** Base asset of a symbol: "BTC-USD" → BTC, "EURUSD" → EUR, "AAPL" → AAPL. */
export function baseAsset(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[\s._]/g, "");
  if (s.includes("-") || s.includes("/")) return s.split(/[-/]/)[0];
  if (INDEX_CODES.has(s)) return s;
  const m = s.match(/^([A-Z]{3})(USD|EUR|JPY|GBP|CHF|AUD|NZD|CAD|USDT|USDC)$/);
  if (m) return m[1];
  return s.replace(/(USDT|USDC|USD)$/, "") || s;
}

export function quoteAsset(symbol: string): string {
  const s = symbol.toUpperCase().replace(/[\s._]/g, "");
  if (s.includes("-") || s.includes("/")) return s.split(/[-/]/)[1] ?? "USD";
  const m = s.match(/(USDT|USDC|USD|EUR|JPY|GBP|CHF|AUD|NZD|CAD)$/);
  return m ? m[1] : "USD";
}

export function sectorOf(symbol: string): Sector {
  const base = baseAsset(symbol);
  if (SECTOR_MAP[base]) return SECTOR_MAP[base];
  if (INDEX_CODES.has(base)) return "index";
  if (FX_CODES.has(base) && FX_CODES.has(quoteAsset(symbol))) return "fx";
  if (/^[A-Z]{1,5}$/.test(base) && !symbol.includes("-")) return "equity";
  return "other";
}

export function isCrypto(symbol: string): boolean {
  const s = sectorOf(symbol);
  return s === "layer1" || s === "layer2" || s === "ai" || s === "defi"
    || s === "gaming" || s === "meme" || s === "payments" || s === "stablecoin";
}

// Correlation clusters. Assets inside a cluster move together; the number is
// the assumed baseline rho used by the correlation engine when no live price
// series is available.
const CLUSTERS: { rho: number; members: string[] }[] = [
  { rho: 0.92, members: ["BTC", "LTC", "BCH"] },
  { rho: 0.88, members: ["ETH", "LTC", "BCH"] },
  { rho: 0.85, members: ["ETH", "SOL", "AVAX", "ADA", "DOT", "NEAR", "APT", "SUI", "ATOM", "MATIC", "ARB", "OP"] },
  { rho: 0.82, members: ["UNI", "AAVE", "CRV", "MKR", "COMP", "SNX", "LDO", "SUSHI", "CAKE"] },
  { rho: 0.80, members: ["FET", "AGIX", "OCEAN", "RNDR", "TAO", "WLD", "GRT"] },
  { rho: 0.78, members: ["DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI"] },
  { rho: 0.75, members: ["AXS", "SAND", "MANA", "GALA", "ENJ", "IMX"] },
  { rho: 0.70, members: ["EUR", "GBP", "CHF", "AUD", "NZD"] },
  { rho: 0.72, members: ["US30", "NAS100", "SPX500", "US500", "GER40", "UK100"] },
];

/** Assumed correlation between two symbols (0..1). Same asset → 1. */
export function assumedCorrelation(a: string, b: string): number {
  const x = baseAsset(a), y = baseAsset(b);
  if (x === y) return 1;
  let best = 0;
  for (const c of CLUSTERS) {
    if (c.members.includes(x) && c.members.includes(y)) best = Math.max(best, c.rho);
  }
  if (best === 0 && isCrypto(a) && isCrypto(b)) best = 0.55; // broad crypto beta
  return best;
}
