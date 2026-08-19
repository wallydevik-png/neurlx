// Memecoin market intelligence.
//
// Data source: DexScreener's public API (no key required), which covers every
// Solana DEX pair including brand-new pump.fun graduations. The scoring model
// below is deliberately deterministic — it encodes what actually separates a
// tradable Solana memecoin from a rug: real locked liquidity, genuine two-sided
// volume, healthy buy pressure, an age band where momentum is real but the
// launch snipers have already been washed out, and a market cap that still has
// room to run. An AI thesis is layered on top for the human reading the desk,
// but it never overrides the hard risk gates.

const DEX_BASE = "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

export type MemeCandidate = {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume5mUsd: number;
  fdvUsd: number;
  ageMinutes: number;
  change5m: number;
  change1h: number;
  change6h: number;
  buySellRatio: number;
  txns24h: number;
  score: number;
  verdict: "snipe" | "watch" | "avoid";
  reasons: string[];
  riskFlags: string[];
  url: string;
};

type DexPair = {
  chainId: string;
  dexId: string;
  url: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  txns?: Record<string, { buys: number; sells: number }>;
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { socials?: unknown[]; websites?: unknown[] };
};

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull a broad slice of the live Solana memecoin market. */
async function fetchSolanaPairs(): Promise<DexPair[]> {
  // Searching the SOL quote mint returns the most active Solana pairs; the
  // boosted-token feed surfaces fresh launches that are getting attention.
  const queries = [
    `${DEX_BASE}/latest/dex/search?q=SOL`,
    `${DEX_BASE}/latest/dex/search?q=pump`,
    `${DEX_BASE}/latest/dex/search?q=WIF`,
    `${DEX_BASE}/latest/dex/search?q=BONK`,
  ];
  const results = await Promise.all(
    queries.map(q => getJson<{ pairs?: DexPair[] }>(q)),
  );
  const seen = new Set<string>();
  const pairs: DexPair[] = [];
  for (const r of results) {
    for (const p of r?.pairs ?? []) {
      if (p.chainId !== "solana") continue;
      if (p.quoteToken?.address !== SOL_MINT && p.quoteToken?.symbol !== "USDC") continue;
      const key = p.baseToken?.address;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      pairs.push(p);
    }
  }
  return pairs;
}

const STABLE_OR_MAJOR = new Set(["SOL", "WSOL", "USDC", "USDT", "JUP", "JITOSOL", "MSOL", "BSOL", "WBTC", "WETH"]);

/** The scoring brain. 0-100, plus the reasoning a trader can audit. */
export function scoreCandidate(p: DexPair): MemeCandidate | null {
  const symbol = (p.baseToken?.symbol ?? "").toUpperCase();
  if (!symbol || STABLE_OR_MAJOR.has(symbol)) return null;

  const priceUsd = Number(p.priceUsd ?? 0);
  const liquidityUsd = Number(p.liquidity?.usd ?? 0);
  const volume24hUsd = Number(p.volume?.["h24"] ?? 0);
  const volume5mUsd = Number(p.volume?.["m5"] ?? 0);
  const volume1hUsd = Number(p.volume?.["h1"] ?? 0);
  const fdvUsd = Number(p.fdv ?? p.marketCap ?? 0);
  const change5m = Number(p.priceChange?.["m5"] ?? 0);
  const change1h = Number(p.priceChange?.["h1"] ?? 0);
  const change6h = Number(p.priceChange?.["h6"] ?? 0);
  const t24 = p.txns?.["h24"] ?? { buys: 0, sells: 0 };
  const t1h = p.txns?.["h1"] ?? { buys: 0, sells: 0 };
  const txns24h = t24.buys + t24.sells;
  const buySellRatio = t1h.sells > 0 ? t1h.buys / t1h.sells : t1h.buys > 0 ? 3 : 1;
  const ageMinutes = p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 60000) : 99999;

  if (!priceUsd || !liquidityUsd) return null;

  const reasons: string[] = [];
  const riskFlags: string[] = [];
  let score = 40;

  // 1. Liquidity depth — the single biggest determinant of whether you can exit.
  if (liquidityUsd >= 250_000) { score += 16; reasons.push(`Deep liquidity $${Math.round(liquidityUsd).toLocaleString()} — clean exits`); }
  else if (liquidityUsd >= 80_000) { score += 12; reasons.push(`Solid liquidity $${Math.round(liquidityUsd).toLocaleString()}`); }
  else if (liquidityUsd >= 25_000) { score += 6; reasons.push(`Tradable liquidity $${Math.round(liquidityUsd).toLocaleString()}`); }
  else { score -= 20; riskFlags.push(`Thin liquidity $${Math.round(liquidityUsd).toLocaleString()} — slippage and exit risk`); }

  // 2. Turnover: real money changing hands relative to pool size.
  const turnover = liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0;
  if (turnover >= 3 && turnover <= 40) { score += 14; reasons.push(`Healthy turnover ${turnover.toFixed(1)}x liquidity in 24h`); }
  else if (turnover > 40) { score += 4; riskFlags.push(`Hyper-rotational turnover ${turnover.toFixed(0)}x — bot-dominated`); }
  else if (turnover < 0.5) { score -= 12; riskFlags.push("Volume is drying up relative to pool size"); }

  // 3. Buy pressure in the last hour.
  if (buySellRatio >= 1.6) { score += 12; reasons.push(`Buy pressure ${buySellRatio.toFixed(2)}:1 over the last hour`); }
  else if (buySellRatio >= 1.15) { score += 6; reasons.push(`Mild net buying ${buySellRatio.toFixed(2)}:1`); }
  else if (buySellRatio < 0.8) { score -= 14; riskFlags.push(`Distribution — sellers outpacing buyers (${buySellRatio.toFixed(2)}:1)`); }

  // 4. Age band. Under 15m is snipe-bot territory; 30m–3d is the sweet spot.
  if (ageMinutes < 15) { score -= 10; riskFlags.push("Under 15 minutes old — launch-bot window, unverified liquidity"); }
  else if (ageMinutes <= 4320) { score += 10; reasons.push(`Age ${ageMinutes < 60 ? `${ageMinutes}m` : `${Math.round(ageMinutes / 60)}h`} — inside the momentum window`); }
  else if (ageMinutes > 43200) { score -= 4; riskFlags.push("Older token — momentum edge is weaker"); }

  // 5. Momentum shape: we want a rising trend, not a vertical blow-off.
  if (change5m > 25) { score -= 12; riskFlags.push(`Vertical 5m candle +${change5m.toFixed(0)}% — chasing the top`); }
  else if (change5m > 2 && change1h > 5) { score += 12; reasons.push(`Stacked momentum: +${change5m.toFixed(1)}% 5m, +${change1h.toFixed(1)}% 1h`); }
  else if (change1h < -15) { score -= 12; riskFlags.push(`Breaking down -${Math.abs(change1h).toFixed(0)}% on the hour`); }
  if (change6h > 0 && change1h > 0) { score += 4; reasons.push("Trend intact across 1h and 6h"); }

  // 6. Room to run — a token already at a huge FDV has less asymmetry.
  if (fdvUsd > 0 && fdvUsd < 2_000_000) { score += 8; reasons.push(`Micro cap $${Math.round(fdvUsd).toLocaleString()} — asymmetric upside`); }
  else if (fdvUsd > 150_000_000) { score -= 8; riskFlags.push("Large cap already — limited multiple left"); }

  // 7. Rug heuristics.
  if (fdvUsd > 0 && liquidityUsd / fdvUsd < 0.015) { score -= 15; riskFlags.push("Liquidity is tiny versus market cap — classic rug shape"); }
  if (txns24h < 150) { score -= 10; riskFlags.push(`Only ${txns24h} trades in 24h — illiquid crowd`); }
  if (!p.info?.socials?.length && !p.info?.websites?.length) { score -= 6; riskFlags.push("No socials or website attached"); }
  if (volume5mUsd === 0 && volume1hUsd === 0) { score -= 15; riskFlags.push("No trading activity in the last hour"); }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const hardFail = liquidityUsd < 15_000 || buySellRatio < 0.6 || (fdvUsd > 0 && liquidityUsd / fdvUsd < 0.008);
  const verdict: MemeCandidate["verdict"] = hardFail ? "avoid" : score >= 72 ? "snipe" : score >= 55 ? "watch" : "avoid";

  return {
    mint: p.baseToken.address,
    symbol,
    name: p.baseToken.name ?? symbol,
    priceUsd, liquidityUsd, volume24hUsd, volume5mUsd, fdvUsd, ageMinutes,
    change5m, change1h, change6h, buySellRatio, txns24h,
    score, verdict, reasons, riskFlags,
    url: p.url,
  };
}

/** Scan the live market and return ranked candidates. */
export async function scanMemecoins(limit = 20): Promise<MemeCandidate[]> {
  const pairs = await fetchSolanaPairs();
  const scored = pairs
    .map(scoreCandidate)
    .filter((c): c is MemeCandidate => c !== null)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Live price for one mint (used for open-position management). */
export async function priceForMint(mint: string): Promise<number | null> {
  const r = await getJson<{ pairs?: DexPair[] }>(`${DEX_BASE}/latest/dex/tokens/${mint}`);
  const best = (r?.pairs ?? [])
    .filter(p => p.chainId === "solana")
    .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
  const price = Number(best?.priceUsd ?? 0);
  return price > 0 ? price : null;
}

/**
 * Optional AI narrative for the top candidates. Purely explanatory — the
 * numeric gates above are what actually authorise a trade.
 */
export async function aiThesis(candidates: MemeCandidate[]): Promise<Record<string, string>> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key || !candidates.length) return {};
  const brief = candidates.slice(0, 5).map(c => ({
    symbol: c.symbol, score: c.score, liq: Math.round(c.liquidityUsd), fdv: Math.round(c.fdvUsd),
    ageMin: c.ageMinutes, c5m: c.change5m, c1h: c.change1h, bsRatio: +c.buySellRatio.toFixed(2),
    flags: c.riskFlags,
  }));
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
      body: JSON.stringify({
        model: "google/gemini-3-flash",
        messages: [
          { role: "system", content: "You are an elite Solana memecoin trader. For each token give ONE punchy sentence (max 22 words) on whether the setup is worth sniping and why. Return strict JSON: {\"SYMBOL\":\"thesis\"}." },
          { role: "user", content: JSON.stringify(brief) },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return {};
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(text) as Record<string, string>;
    return parsed;
  } catch {
    return {};
  }
}
