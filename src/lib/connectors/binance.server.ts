// Read-only Binance connector. Public market data works without keys.
// Signed endpoints (balances, trades) work when an API key + secret are
// provided; only READ scope is ever used — no trading endpoints, no
// withdrawal endpoints. Runs on Cloudflare Worker runtime (Web Crypto).
import type {
  Balance, ConnectorPosition, HistoryEntry, PlaceOrderInput, PlaceOrderResult,
  Quote, TradingConnector,
} from "./types";

const BASE = "https://api.binance.com";

// Translate our canonical symbol (BTC-USD) to Binance's (BTCUSDT).
function toBinance(symbol: string): string {
  if (!symbol.includes("-")) return symbol.toUpperCase();
  const [base, quote] = symbol.toUpperCase().split("-");
  const q = quote === "USD" ? "USDT" : quote;
  return `${base}${q}`;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signedGet(path: string, params: Record<string, string | number>, apiKey: string, apiSecret: string) {
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(Date.now()),
    recvWindow: "5000",
  }).toString();
  const sig = await hmacSha256Hex(apiSecret, qs);
  const res = await fetch(`${BASE}${path}?${qs}&signature=${sig}`, {
    headers: { "X-MBX-APIKEY": apiKey },
  });
  if (!res.ok) throw new Error(`Binance ${path} failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

async function publicGet(path: string, params?: Record<string, string>) {
  const url = `${BASE}${path}${params ? "?" + new URLSearchParams(params).toString() : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${path} failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

export function createBinanceConnector(credentials: Record<string, string>): TradingConnector {
  const apiKey = credentials.apiKey ?? "";
  const apiSecret = credentials.apiSecret ?? "";
  const hasKeys = Boolean(apiKey && apiSecret);

  const rejectWrite = (): never => {
    throw new Error("This build is READ-ONLY. Binance trading endpoints are intentionally disabled.");
  };

  return {
    id: "binance",
    displayName: "Binance (Read-Only)",

    async verify() {
      // Always ping public REST; if keys present, also verify account read access.
      const ping = await fetch(`${BASE}/api/v3/ping`);
      if (!ping.ok) return { ok: false, message: `Binance unreachable (${ping.status})` };
      if (!hasKeys) return { ok: true, message: "Public market data reachable. No API key — balances unavailable." };
      try {
        // Signed account read — will fail if key lacks 'Enable Reading' permission.
        await signedGet("/api/v3/account", {}, apiKey, apiSecret);
        return { ok: true, message: "Read access verified." };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : "Key verification failed" };
      }
    },

    async getBalances(): Promise<Balance[]> {
      if (!hasKeys) return [];
      const acct = await signedGet("/api/v3/account", {}, apiKey, apiSecret) as {
        balances: { asset: string; free: string; locked: string }[];
      };
      return acct.balances
        .map(b => ({
          currency: b.asset,
          total: Number(b.free) + Number(b.locked),
          available: Number(b.free),
        }))
        .filter(b => b.total > 0);
    },

    async getQuote(symbol): Promise<Quote> {
      const s = toBinance(symbol);
      const [ticker, book] = await Promise.all([
        publicGet("/api/v3/ticker/price", { symbol: s }) as Promise<{ price: string }>,
        publicGet("/api/v3/ticker/bookTicker", { symbol: s }) as Promise<{ bidPrice: string; askPrice: string }>,
      ]);
      const mid = Number(ticker.price);
      return {
        symbol,
        mid,
        bid: Number(book.bidPrice) || mid,
        ask: Number(book.askPrice) || mid,
        ts: Date.now(),
      };
    },

    // Spot has no "positions"; we surface non-zero balances as long positions.
    async getPositions(): Promise<ConnectorPosition[]> {
      if (!hasKeys) return [];
      const balances = await this.getBalances();
      // We cannot know avgEntry from Binance without trade history walkback.
      return balances
        .filter(b => b.currency !== "USDT" && b.currency !== "USD" && b.total > 0)
        .map(b => ({ symbol: `${b.currency}-USD`, qty: b.total, avgEntry: 0 }));
    },

    async getHistory(limit = 50): Promise<HistoryEntry[]> {
      if (!hasKeys) return [];
      // Requires a symbol per Binance; we sample the biggest balance pair.
      const balances = await this.getBalances();
      const top = balances.filter(b => b.currency !== "USDT" && b.currency !== "USD").sort((a, b) => b.total - a.total)[0];
      if (!top) return [];
      const symbol = `${top.currency}USDT`;
      const trades = await signedGet("/api/v3/myTrades", { symbol, limit }, apiKey, apiSecret) as {
        id: number; price: string; qty: string; commission: string; time: number; isBuyer: boolean;
      }[];
      return trades.map(t => ({
        externalOrderId: String(t.id),
        symbol: `${top.currency}-USD`,
        side: t.isBuyer ? "buy" as const : "sell" as const,
        qty: Number(t.qty),
        price: Number(t.price),
        fees: Number(t.commission),
        ts: t.time,
      }));
    },

    placeOrder(_: PlaceOrderInput): Promise<PlaceOrderResult> { return Promise.resolve(rejectWrite()); },
    cancelOrder(): Promise<{ ok: boolean }> { return Promise.resolve(rejectWrite()); },
  };
}
