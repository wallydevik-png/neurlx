// Market Intelligence provider framework.
// Signals are normalised: score in [-1, 1] (bearish..bullish), confidence in [0, 1].
export type IntelKind = "consensus" | "headline" | "fear_greed" | "social" | "flow";

export interface IntelSignal {
  provider: string;          // 'analyst' | 'sentiment' | 'news' | 'social'
  kind: IntelKind;
  score: number;             // -1..1
  confidence: number;        // 0..1
  payload?: Record<string, unknown>;
}

export interface IntelProvider {
  id: string;
  displayName: string;
  weight: number;            // relative weight in consensus (0..1)
  supports(symbol: string): boolean;
  fetch(symbol: string): Promise<IntelSignal[]>;
}

export interface Consensus {
  score: number;
  confidence: number;
  verdict: "Strong Sell" | "Sell" | "Neutral" | "Buy" | "Strong Buy";
  contributors: Array<{ provider: string; weight: number; score: number; confidence: number }>;
}
