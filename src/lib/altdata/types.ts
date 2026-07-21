export type AltKind = "orderbook" | "funding" | "open_interest" | "onchain" | "calendar";

export interface AltSignal {
  kind: AltKind;
  provider: string;
  score: number;
  confidence: number;
  payload: Record<string, any>;
}

export interface AltDataProvider {
  id: string;
  displayName: string;
  kinds: AltKind[];
  supports(symbol: string): boolean;
  fetch(symbol: string): Promise<AltSignal[]>;
}

export interface AltComposite {
  score: number;
  confidence: number;
  vol_risk: number;
  verdict: "Strong Sell" | "Sell" | "Neutral" | "Buy" | "Strong Buy";
}