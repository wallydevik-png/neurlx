// Alternative Data Engine — orderbook depth, funding, open interest,
// on-chain flows, and economic calendar. Deterministic-per-5min-bucket
// synthetic providers so the layer is fully wired end-to-end today; each
// provider is a swap-in point for real vendors (Kaiko, Coinglass, Glassnode,
// Trading Economics) via the AltDataProvider interface.

export type AltKind = "orderbook" | "funding" | "open_interest" | "onchain" | "calendar";

export interface AltSignal {
  kind: AltKind;
  provider: string;
  score: number;        // -1..1 directional pressure
  confidence: number;   // 0..1
  payload: Record<string, any>;
}

export interface AltDataProvider {
  id: string;
  displayName: string;
  kinds: AltKind[];
  supports(symbol: string): boolean;
  fetch(symbol: string): Promise<AltSignal[]>;
}

function seed(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(s: number) { let x = s || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 1_000_000) / 1_000_000; }; }
const bucket = () => Math.floor(Date.now() / (5 * 60_000));
const norm = (r: () => number) => r() * 2 - 1;

const orderbook: AltDataProvider = {
  id: "orderbook", displayName: "Orderbook Depth", kinds: ["orderbook"],
  supports: () => true,
  async fetch(symbol) {
    const r = rng(seed(`ob:${symbol}:${bucket()}`));
    const bidDepth = 500_000 + r() * 4_500_000;
    const askDepth = 500_000 + r() * 4_500_000;
    const imbalance = (bidDepth - askDepth) / (bidDepth + askDepth);
    const spreadBps = 1 + r() * 6;
    const walls = Array.from({ length: 3 }, (_, i) => ({
      side: r() > 0.5 ? "bid" : "ask",
      distance_bps: 5 + i * 12 + Math.floor(r() * 8),
      size_usd: Math.floor(200_000 + r() * 800_000),
    }));
    return [{
      kind: "orderbook", provider: "orderbook",
      score: imbalance, confidence: 0.55 + r() * 0.25,
      payload: {
        bid_depth_usd: Math.floor(bidDepth),
        ask_depth_usd: Math.floor(askDepth),
        imbalance_pct: Number((imbalance * 100).toFixed(2)),
        spread_bps: Number(spreadBps.toFixed(2)),
        walls,
      },
    }];
  },
};

const funding: AltDataProvider = {
  id: "funding", displayName: "Perp Funding", kinds: ["funding", "open_interest"],
  supports: (s) => s.endsWith("-USD"),
  async fetch(symbol) {
    const r = rng(seed(`fund:${symbol}:${bucket()}`));
    const rate = (norm(r) * 0.05);                       // % per 8h
    const oiUsd = 100_000_000 + r() * 3_000_000_000;
    const oiChange = norm(rng(seed(`oi:${symbol}:${bucket()}`))) * 12;
    // Elevated funding + rising OI = trend continuation (bullish/bearish depending on sign)
    const fundingScore = Math.tanh(rate * 40) * -1;      // extreme funding = mean reversion signal
    const oiScore = Math.tanh(oiChange / 8) * Math.sign(rate || 0.001);
    return [
      {
        kind: "funding", provider: "funding",
        score: fundingScore, confidence: 0.5 + Math.min(0.4, Math.abs(rate) * 8),
        payload: {
          rate_pct_8h: Number(rate.toFixed(4)),
          annualized_pct: Number((rate * 3 * 365).toFixed(1)),
          regime: Math.abs(rate) > 0.03 ? "Extreme" : Math.abs(rate) > 0.01 ? "Elevated" : "Neutral",
        },
      },
      {
        kind: "open_interest", provider: "funding",
        score: oiScore, confidence: 0.45 + r() * 0.3,
        payload: {
          open_interest_usd: Math.floor(oiUsd),
          change_24h_pct: Number(oiChange.toFixed(2)),
        },
      },
    ];
  },
};

const onchain: AltDataProvider = {
  id: "onchain", displayName: "On-chain Flows", kinds: ["onchain"],
  supports: (s) => s.endsWith("-USD"),
  async fetch(symbol) {
    const r = rng(seed(`chain:${symbol}:${bucket()}`));
    // Net exchange inflow (bearish if positive)
    const netInflow = norm(r) * 50_000_000;
    const whaleTxs = Math.floor(20 + r() * 180);
    const stablecoinNet = norm(rng(seed(`stbl:${symbol}:${bucket()}`))) * 200_000_000;
    // Negative inflow (outflow) = bullish; positive stablecoin mints = bullish
    const score = Math.tanh(-netInflow / 30_000_000) * 0.6 + Math.tanh(stablecoinNet / 150_000_000) * 0.4;
    return [{
      kind: "onchain", provider: "onchain",
      score, confidence: 0.4 + r() * 0.35,
      payload: {
        exchange_net_inflow_usd: Math.floor(netInflow),
        whale_txs_24h: whaleTxs,
        stablecoin_net_supply_usd: Math.floor(stablecoinNet),
      },
    }];
  },
};

const calendar: AltDataProvider = {
  id: "calendar", displayName: "Economic Calendar", kinds: ["calendar"],
  supports: () => true,
  async fetch(symbol) {
    const r = rng(seed(`cal:${symbol}:${Math.floor(Date.now() / (60 * 60_000))}`));
    const events = [
      { title: "US CPI m/m", impact: "high", when: "in 3d", forecast: "0.3%", prior: "0.2%" },
      { title: "FOMC minutes", impact: "high", when: "in 6d", forecast: "—", prior: "—" },
      { title: "US Nonfarm Payrolls", impact: "high", when: "in 8d", forecast: "180k", prior: "199k" },
      { title: "ECB rate decision", impact: "medium", when: "in 11d", forecast: "3.75%", prior: "3.75%" },
      { title: "China Manufacturing PMI", impact: "medium", when: "in 4d", forecast: "50.1", prior: "49.9" },
    ].filter(() => r() > 0.15).slice(0, 4);
    // Calendar itself doesn't have direction, but flags upcoming volatility risk
    const volRisk = events.filter(e => e.impact === "high").length * 0.25;
    return [{
      kind: "calendar", provider: "calendar",
      score: 0, confidence: Math.min(0.9, 0.4 + volRisk),
      payload: { events, high_impact_next_7d: events.filter(e => e.impact === "high").length },
    }];
  },
};

export const REGISTRY: AltDataProvider[] = [orderbook, funding, onchain, calendar];

export async function collectAltSignals(symbol: string): Promise<AltSignal[]> {
  const relevant = REGISTRY.filter(p => p.supports(symbol));
  const results = await Promise.all(relevant.map(p => p.fetch(symbol).catch(() => [] as AltSignal[])));
  return results.flat();
}

export interface AltComposite {
  score: number;        // -1..1 (aggregate directional pressure, ex calendar)
  confidence: number;   // 0..1
  vol_risk: number;     // 0..1 (calendar-driven)
  verdict: "Strong Sell" | "Sell" | "Neutral" | "Buy" | "Strong Buy";
}
export function computeAltComposite(signals: AltSignal[]): AltComposite {
  const directional = signals.filter(s => s.kind !== "calendar");
  const cal = signals.find(s => s.kind === "calendar");
  let num = 0, den = 0, cSum = 0;
  for (const s of directional) {
    const w = s.confidence;
    num += s.score * w; den += w; cSum += s.confidence;
  }
  const score = den > 0 ? num / den : 0;
  const confidence = directional.length ? cSum / directional.length : 0;
  const vol_risk = cal ? Math.min(1, ((cal.payload?.high_impact_next_7d ?? 0) as number) * 0.34) : 0;
  const verdict: AltComposite["verdict"] =
    score <= -0.5 ? "Strong Sell" :
    score <= -0.15 ? "Sell" :
    score < 0.15 ? "Neutral" :
    score < 0.5 ? "Buy" : "Strong Buy";
  return { score, confidence, vol_risk, verdict };
}
