// On-chain swap execution through Jupiter (the Solana DEX aggregator).
//
// The trading wallet's secret key never leaves the server: it is stored
// encrypted (AES-256-GCM) and only decrypted inside these handlers to sign a
// single transaction.
//
// All RPC goes over plain HTTP JSON-RPC rather than web3.js's `Connection`,
// which drags in a websocket subscription client that cannot resolve in the
// Cloudflare Worker runtime.
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";

export function rpcUrl(): string {
  return process.env["SOLANA_RPC_URL"] || "https://api.mainnet-beta.solana.com";
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${method} failed (${res.status})`);
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

export function keypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export async function solBalance(pubkey: string): Promise<number> {
  const r = await rpc<{ value: number }>("getBalance", [pubkey, { commitment: "confirmed" }]);
  return (r?.value ?? 0) / 1e9;
}

export async function tokenBalance(owner: string, mint: string): Promise<{ amount: number; decimals: number }> {
  const r = await rpc<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }>;
  }>("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const raw = r?.value?.[0]?.account?.data?.parsed?.info?.tokenAmount;
  return { amount: raw ? Number(raw.amount) : 0, decimals: raw?.decimals ?? 0 };
}

type Quote = { outAmount: string; inAmount: string; priceImpactPct?: string; routePlan?: unknown[] };

export async function getQuote(inputMint: string, outputMint: string, amountRaw: number, slippageBps: number): Promise<Quote> {
  const url = `${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amountRaw)}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Jupiter quote failed (${res.status}): ${await res.text()}`);
  const q = await res.json() as Quote;
  if (!q?.outAmount) throw new Error("No route available for this token");
  return q;
}

/** Quote -> build -> sign -> send. Returns the transaction signature. */
export async function swap(opts: {
  secret: string; inputMint: string; outputMint: string; amountRaw: number; slippageBps: number;
}): Promise<{ signature: string; outAmount: number; priceImpactPct: number }> {
  const kp = keypairFromSecret(opts.secret);
  const quote = await getQuote(opts.inputMint, opts.outputMint, opts.amountRaw, opts.slippageBps);

  const buildRes = await fetch(`${JUP}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
    }),
  });
  if (!buildRes.ok) throw new Error(`Jupiter swap build failed (${buildRes.status}): ${await buildRes.text()}`);
  const { swapTransaction } = await buildRes.json() as { swapTransaction: string };

  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(swapTransaction), c => c.charCodeAt(0)));
  tx.sign([kp]);

  const encoded = btoa(String.fromCharCode(...tx.serialize()));
  const signature = await rpc<string>("sendTransaction", [
    encoded, { encoding: "base64", maxRetries: 3, preflightCommitment: "confirmed" },
  ]);

  return {
    signature,
    outAmount: Number(quote.outAmount),
    priceImpactPct: Number(quote.priceImpactPct ?? 0) * 100,
  };
}
