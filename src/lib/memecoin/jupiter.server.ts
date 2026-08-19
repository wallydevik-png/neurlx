// On-chain swap execution through Jupiter (the Solana DEX aggregator).
//
// The trading wallet's secret key never leaves the server: it is stored
// encrypted (AES-256-GCM) and only decrypted inside these handlers to sign a
// single transaction.
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";

export function rpcUrl(): string {
  return process.env["SOLANA_RPC_URL"] || "https://api.mainnet-beta.solana.com";
}

export function keypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export async function solBalance(pubkey: string): Promise<number> {
  const conn = new Connection(rpcUrl(), "confirmed");
  const { PublicKey } = await import("@solana/web3.js");
  const lamports = await conn.getBalance(new PublicKey(pubkey));
  return lamports / 1e9;
}

export async function tokenBalance(owner: string, mint: string): Promise<{ amount: number; decimals: number }> {
  const conn = new Connection(rpcUrl(), "confirmed");
  const { PublicKey } = await import("@solana/web3.js");
  const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  const acct = res.value[0]?.account.data as unknown as
    { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } } | undefined;
  const raw = acct?.parsed?.info?.tokenAmount;
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

  const conn = new Connection(rpcUrl(), "confirmed");
  const signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3, skipPreflight: false });
  return {
    signature,
    outAmount: Number(quote.outAmount),
    priceImpactPct: Number(quote.priceImpactPct ?? 0) * 100,
  };
}
