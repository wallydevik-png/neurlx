// Market Intelligence providers.
// Each provider first tries a REAL keyless feed (Yahoo Finance, alternative.me,
// CoinGecko — see realProviders.server.ts). Only if that feed is unavailable
// does it fall back to the deterministic synthetic generator below, and the
// fallback is always flagged with `payload.source = "synthetic-fallback"` so
// the UI never presents simulated data as real.
import type { IntelProvider, IntelSignal } from "./types";
import { realTrend, realNews, realSentiment, realSocial } from "./realProviders.server";


function seed(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(s: number) {
  let x = s || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1_000_000) / 1_000_000; };
}
function bucket() { return Math.floor(Date.now() / (30 * 60_000)); }
function norm(r: () => number) { return r() * 2 - 1; }

const HEADLINES = [
  "posts record quarterly volume", "faces regulatory review", "onboards major partner",
  "hits new 90-day high", "sees whale accumulation", "loses key support level",
  "network upgrade goes live", "sees ETF inflows", "cited by top analyst as overvalued",
  "beats revenue estimates", "trims workforce amid slowdown", "unveils new product line",
];

/** Wraps a real feed with the synthetic generator as a flagged fallback. */
function withRealFeed(
  base: Omit<IntelProvider, "fetch">,
  real: (symbol: string) => Promise<IntelSignal[] | null>,
  syntheticFetch: (symbol: string) => Promise<IntelSignal[]>,
): IntelProvider {
  return {
    ...base,
    async fetch(symbol) {
      try {
        const live = await real(symbol);
        if (live && live.length) return live;
      } catch (e) {
        console.warn(`[intel] real feed failed for ${base.id}/${symbol}`, e);
      }
      const fallback = await syntheticFetch(symbol);
      return fallback.map(s => ({
        ...s,
        confidence: s.confidence * 0.4,   // simulated data must never drive conviction
        payload: { ...(s.payload ?? {}), source: "synthetic-fallback", is_synthetic: true },
      }));
    },
  };
}

async function syntheticAnalyst(symbol: string): Promise<IntelSignal[]> {
  const r = rng(seed(`analyst:${symbol}:${bucket()}`));
  const score = norm(r) * 0.8;
  const buys = Math.floor(r() * 25) + 5;
  const holds = Math.floor(r() * 15) + 2;
  const sells = Math.floor(r() * 10);
  const priceTarget = (1 + score * 0.25) * 100;
  return [{
    provider: "analyst", kind: "consensus",
    score, confidence: 0.55 + r() * 0.35,
    payload: { buys, holds, sells, analysts: buys + holds + sells, price_target_pct: priceTarget.toFixed(1) },
  }];
}

async function syntheticSentiment(symbol: string): Promise<IntelSignal[]> {
  const r = rng(seed(`sentiment:${symbol}:${bucket()}`));
  const s = norm(r) * 0.9;
  const fg = Math.round((s + 1) * 50);
  return [{
    provider: "sentiment", kind: "fear_greed",
    score: s, confidence: 0.5 + r() * 0.3,
    payload: { fear_greed: fg, label: fg < 25 ? "Extreme Fear" : fg < 45 ? "Fear" : fg < 55 ? "Neutral" : fg < 75 ? "Greed" : "Extreme Greed" },
  }];
}

async function syntheticNews(symbol: string): Promise<IntelSignal[]> {
  const r = rng(seed(`news:${symbol}:${bucket()}`));
  const count = 3 + Math.floor(r() * 4);
  const items = Array.from({ length: count }, (_, i) => {
    const s = norm(rng(seed(`news:${symbol}:${bucket()}:${i}`)));
    return {
      title: `${symbol} ${HEADLINES[Math.floor(rng(seed(`h:${symbol}:${bucket()}:${i}`))() * HEADLINES.length)]}`,
      score: s,
      source: ["Reuters", "Bloomberg", "CoinDesk", "The Block", "WSJ"][i % 5],
      ago_min: 5 + i * 22,
    };
  });
  const avg = items.reduce((a, b) => a + b.score, 0) / items.length;
  return [{
    provider: "news", kind: "headline",
    score: avg, confidence: 0.45 + r() * 0.3,
    payload: { count, items },
  }];
}

async function syntheticSocial(symbol: string): Promise<IntelSignal[]> {
  const r = rng(seed(`social:${symbol}:${bucket()}`));
  const s = norm(r);
  return [{
    provider: "social", kind: "social",
    score: s * 0.8, confidence: 0.35 + r() * 0.3,
    payload: {
      mentions_24h: Math.floor(500 + r() * 8000),
      mentions_change_pct: Number((r() * 200 - 50).toFixed(1)),
      top_source: ["X/Twitter", "Reddit", "StockTwits", "Telegram"][Math.floor(r() * 4)],
    },
  }];
}

const analyst = withRealFeed(
  { id: "analyst", displayName: "Trend Consensus (Yahoo Finance)", weight: 0.35, supports: () => true },
  realTrend, syntheticAnalyst,
);
const sentiment = withRealFeed(
  { id: "sentiment", displayName: "Fear & Greed (alternative.me)", weight: 0.2, supports: () => true },
  realSentiment, syntheticSentiment,
);
const news = withRealFeed(
  { id: "news", displayName: "News Flow (Yahoo Finance)", weight: 0.25, supports: () => true },
  realNews, syntheticNews,
);
const social = withRealFeed(
  { id: "social", displayName: "Social Momentum (CoinGecko)", weight: 0.2, supports: () => true },
  realSocial, syntheticSocial,
);

export const REGISTRY: IntelProvider[] = [analyst, sentiment, news, social];

export function providersFor(symbol: string): IntelProvider[] {
  return REGISTRY.filter(p => p.supports(symbol));
}

export async function collectSignals(symbol: string): Promise<IntelSignal[]> {
  const results = await Promise.all(providersFor(symbol).map(p => p.fetch(symbol).catch(() => [])));
  return results.flat();
}

}
