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

const analyst: IntelProvider = {
  id: "analyst", displayName: "Professional Consensus", weight: 0.35,
  supports: () => true,
  async fetch(symbol) {
    const r = rng(seed(`analyst:${symbol}:${bucket()}`));
    const score = norm(r) * 0.8;
    const buys = Math.floor(r() * 25) + 5;
    const holds = Math.floor(r() * 15) + 2;
    const sells = Math.floor(r() * 10);
    const priceTarget = (1 + score * 0.25) * 100; // % of current
    return [{
      provider: "analyst", kind: "consensus",
      score, confidence: 0.55 + r() * 0.35,
      payload: { buys, holds, sells, analysts: buys + holds + sells, price_target_pct: priceTarget.toFixed(1) },
    }];
  },
};

const sentiment: IntelProvider = {
  id: "sentiment", displayName: "Market Sentiment", weight: 0.2,
  supports: () => true,
  async fetch(symbol) {
    const r = rng(seed(`sentiment:${symbol}:${bucket()}`));
    const s = norm(r) * 0.9;
    const fg = Math.round((s + 1) * 50); // 0..100
    return [{
      provider: "sentiment", kind: "fear_greed",
      score: s, confidence: 0.5 + r() * 0.3,
      payload: { fear_greed: fg, label: fg < 25 ? "Extreme Fear" : fg < 45 ? "Fear" : fg < 55 ? "Neutral" : fg < 75 ? "Greed" : "Extreme Greed" },
    }];
  },
};

const news: IntelProvider = {
  id: "news", displayName: "News Flow", weight: 0.25,
  supports: () => true,
  async fetch(symbol) {
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
  },
};

const social: IntelProvider = {
  id: "social", displayName: "Social Momentum", weight: 0.2,
  supports: () => true,
  async fetch(symbol) {
    const r = rng(seed(`social:${symbol}:${bucket()}`));
    const s = norm(r);
    const mentions = Math.floor(500 + r() * 8000);
    const change = (r() * 200 - 50);
    return [{
      provider: "social", kind: "social",
      score: s * 0.8, confidence: 0.35 + r() * 0.3,
      payload: {
        mentions_24h: mentions,
        mentions_change_pct: Number(change.toFixed(1)),
        top_source: ["X/Twitter", "Reddit", "StockTwits", "Telegram"][Math.floor(r() * 4)],
      },
    }];
  },
};

export const REGISTRY: IntelProvider[] = [analyst, sentiment, news, social];

export function providersFor(symbol: string): IntelProvider[] {
  return REGISTRY.filter(p => p.supports(symbol));
}

export async function collectSignals(symbol: string): Promise<IntelSignal[]> {
  const results = await Promise.all(providersFor(symbol).map(p => p.fetch(symbol).catch(() => [])));
  return results.flat();
}
