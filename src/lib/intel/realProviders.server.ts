// REAL market-intelligence feeds.
//   * Trend consensus + volatility  -> Yahoo Finance chart API (all asset classes)
//   * Headline sentiment            -> Yahoo Finance news search + lexicon scoring
//   * Fear & Greed                  -> alternative.me (crypto) / price-derived (other)
//   * Social momentum               -> CoinGecko community metrics (crypto only)
// All calls are keyless, cached in-process for 15 minutes, and fail soft:
// a provider that errors returns null so the caller can fall back to the
// synthetic generator, flagged as such in the payload.
import type { IntelSignal } from "./types";
import { toYahoo, toCoinGeckoId, isCrypto } from "./symbolMap";

const TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function getJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // Yahoo rejects requests without a browser-ish UA.
        "User-Agent": "Mozilla/5.0 (compatible; NeurlX/1.0)",
        Accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const clamp = (n: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, n));

// ---------------------------------------------------------------- price series

export interface PriceSeries {
  closes: number[];
  last: number;
  currency: string;
}

export async function fetchSeries(symbol: string): Promise<PriceSeries | null> {
  const yf = toYahoo(symbol);
  if (!yf) return null;
  return cached(`series:${yf}`, async () => {
    try {
      const j = await getJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yf)}?interval=1d&range=6mo`,
      );
      const r = j?.chart?.result?.[0];
      const closes: number[] = (r?.indicators?.quote?.[0]?.close ?? []).filter(
        (c: unknown): c is number => typeof c === "number" && Number.isFinite(c),
      );
      if (closes.length < 30) return null;
      return {
        closes,
        last: closes[closes.length - 1],
        currency: r?.meta?.currency ?? "USD",
      } satisfies PriceSeries;
    } catch {
      return null;
    }
  });
}

function sma(v: number[], n: number): number {
  const s = v.slice(-n);
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function pctChange(v: number[], n: number): number {
  if (v.length <= n) return 0;
  const past = v[v.length - 1 - n];
  return past ? (v[v.length - 1] - past) / past : 0;
}
function annualisedVol(v: number[], n = 30): number {
  const s = v.slice(-(n + 1));
  const rets: number[] = [];
  for (let i = 1; i < s.length; i++) if (s[i - 1]) rets.push(s[i] / s[i - 1] - 1);
  if (rets.length < 5) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(252);
}

/** Real, price-derived trend consensus across 1w / 1m / 3m horizons. */
export async function realTrend(symbol: string): Promise<IntelSignal[] | null> {
  const series = await fetchSeries(symbol);
  if (!series) return null;
  const { closes, last } = series;
  const w = pctChange(closes, 5);
  const m = pctChange(closes, 21);
  const q = pctChange(closes, 63);
  const sma50 = sma(closes, 50);
  const sma200 = closes.length >= 200 ? sma(closes, 200) : sma(closes, closes.length);
  const above50 = last > sma50 ? 1 : -1;
  const above200 = last > sma200 ? 1 : -1;
  const raw =
    clamp(w * 8) * 0.2 + clamp(m * 4) * 0.3 + clamp(q * 2.5) * 0.2 + above50 * 0.15 + above200 * 0.15;
  const agree = [Math.sign(w), Math.sign(m), Math.sign(q), above50, above200];
  const dominant = agree.filter(x => x === Math.sign(raw) && x !== 0).length / agree.length;
  return [{
    provider: "analyst",
    kind: "consensus",
    score: clamp(raw),
    confidence: clamp(0.35 + dominant * 0.55, 0, 0.95),
    payload: {
      source: "yahoo-finance",
      last_price: +last.toFixed(6),
      change_1w_pct: +(w * 100).toFixed(2),
      change_1m_pct: +(m * 100).toFixed(2),
      change_3m_pct: +(q * 100).toFixed(2),
      sma50: +sma50.toFixed(6),
      sma200: +sma200.toFixed(6),
      above_sma50: last > sma50,
      above_sma200: last > sma200,
      annualised_vol_pct: +(annualisedVol(closes) * 100).toFixed(1),
    },
  }];
}

// ------------------------------------------------------------------- headlines

const BULL_WORDS = [
  "surge", "soar", "rally", "gain", "jump", "beat", "record", "upgrade", "bullish",
  "outperform", "inflow", "adoption", "approval", "breakout", "high", "profit", "boost", "rise",
];
const BEAR_WORDS = [
  "plunge", "slump", "fall", "drop", "loss", "miss", "downgrade", "bearish", "selloff",
  "outflow", "ban", "lawsuit", "hack", "probe", "warning", "crash", "slide", "cut", "fear",
];

function scoreHeadline(title: string): number {
  const t = title.toLowerCase();
  let s = 0;
  for (const w of BULL_WORDS) if (t.includes(w)) s += 1;
  for (const w of BEAR_WORDS) if (t.includes(w)) s -= 1;
  return clamp(s / 3);
}

export async function realNews(symbol: string): Promise<IntelSignal[] | null> {
  const yf = toYahoo(symbol);
  if (!yf) return null;
  return cached(`news:${yf}`, async () => {
    try {
      const j = await getJson(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yf)}&newsCount=8&quotesCount=0`,
      );
      const news: any[] = Array.isArray(j?.news) ? j.news : [];
      if (!news.length) return null;
      const items = news.slice(0, 8).map(n => ({
        title: String(n.title ?? ""),
        source: String(n.publisher ?? "Yahoo Finance"),
        url: String(n.link ?? ""),
        ago_min: n.providerPublishTime
          ? Math.max(0, Math.round((Date.now() / 1000 - Number(n.providerPublishTime)) / 60))
          : null,
        score: scoreHeadline(String(n.title ?? "")),
      }));
      const scored = items.filter(i => i.score !== 0);
      const avg = scored.length ? scored.reduce((a, b) => a + b.score, 0) / scored.length : 0;
      return [{
        provider: "news",
        kind: "headline",
        score: clamp(avg),
        confidence: clamp(0.25 + (scored.length / items.length) * 0.5, 0, 0.85),
        payload: { source: "yahoo-finance-news", count: items.length, scored: scored.length, items },
      }] satisfies IntelSignal[];
    } catch {
      return null;
    }
  });
}

// --------------------------------------------------------------- fear & greed

async function cryptoFearGreed(): Promise<{ value: number; label: string } | null> {
  return cached("fng", async () => {
    try {
      const j = await getJson("https://api.alternative.me/fng/?limit=1");
      const d = j?.data?.[0];
      if (!d) return null;
      return { value: Number(d.value), label: String(d.value_classification) };
    } catch {
      return null;
    }
  });
}

export async function realSentiment(symbol: string): Promise<IntelSignal[] | null> {
  if (isCrypto(symbol)) {
    const fg = await cryptoFearGreed();
    if (fg) {
      return [{
        provider: "sentiment",
        kind: "fear_greed",
        // Contrarian-tempered: extreme fear is mildly bullish, extreme greed mildly bearish,
        // but the prevailing reading still dominates direction.
        score: clamp((fg.value - 50) / 50 * 0.8),
        confidence: 0.7,
        payload: { source: "alternative.me", fear_greed: fg.value, label: fg.label, scope: "crypto-market" },
      }];
    }
  }
  // Non-crypto (or FNG unavailable): derive a fear/greed proxy from realised
  // volatility and drawdown from the 6-month high.
  const series = await fetchSeries(symbol);
  if (!series) return null;
  const { closes, last } = series;
  const high = Math.max(...closes);
  const dd = high ? (last - high) / high : 0;         // <= 0
  const vol = annualisedVol(closes);
  const volPenalty = clamp(-(vol - 0.2) * 1.5, -1, 0.3);
  const value = Math.round(clamp(1 + dd * 4 + volPenalty, -1, 1) * 50 + 50);
  return [{
    provider: "sentiment",
    kind: "fear_greed",
    score: clamp((value - 50) / 50 * 0.7),
    confidence: 0.5,
    payload: {
      source: "derived:yahoo-finance",
      fear_greed: value,
      label: value < 25 ? "Extreme Fear" : value < 45 ? "Fear" : value < 55 ? "Neutral" : value < 75 ? "Greed" : "Extreme Greed",
      drawdown_from_6m_high_pct: +(dd * 100).toFixed(2),
      annualised_vol_pct: +(vol * 100).toFixed(1),
    },
  }];
}

// --------------------------------------------------------------------- social

export async function realSocial(symbol: string): Promise<IntelSignal[] | null> {
  const id = toCoinGeckoId(symbol);
  if (!id) return null;
  return cached(`cg:${id}`, async () => {
    try {
      const j = await getJson(
        `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false&sparkline=false`,
      );
      const up = Number(j?.sentiment_votes_up_percentage);
      const md = j?.market_data ?? {};
      const d24 = Number(md?.price_change_percentage_24h ?? 0);
      const community = j?.community_data ?? {};
      const votes = Number.isFinite(up) ? clamp((up - 50) / 50) : 0;
      const score = clamp(votes * 0.7 + clamp(d24 / 10) * 0.3);
      return [{
        provider: "social",
        kind: "social",
        score,
        confidence: Number.isFinite(up) ? 0.6 : 0.35,
        payload: {
          source: "coingecko",
          sentiment_votes_up_pct: Number.isFinite(up) ? +up.toFixed(1) : null,
          price_change_24h_pct: +d24.toFixed(2),
          market_cap_rank: j?.market_cap_rank ?? null,
          twitter_followers: community?.twitter_followers ?? null,
          reddit_subscribers: community?.reddit_subscribers ?? null,
        },
      }] satisfies IntelSignal[];
    } catch {
      return null;
    }
  });
}
