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
import { mnemonicToSeedWebcrypto, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";

/**
 * Solana RPC endpoints, tried in order.
 *
 * `api.mainnet-beta.solana.com` rejects datacenter/edge egress with HTTP 403
 * ("Balance unavailable: Solana RPC getBalance failed (403)"), which is why a
 * funded wallet showed no balance at all. A single hardcoded endpoint is a
 * single point of failure, so we fail over across public endpoints and only
 * report an error when every one of them refuses.
 */
export function rpcEndpoints(): string[] {
  const configured = process.env["SOLANA_RPC_URL"];
  return [
    ...(configured ? [configured] : []),
    "https://solana-rpc.publicnode.com",
    "https://api.mainnet-beta.solana.com",
    "https://solana.api.onfinality.io/public",
  ];
}

export function rpcUrl(): string {
  return rpcEndpoints()[0]!;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const errors: string[] = [];
  for (const url of rpcEndpoints()) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (e) {
      errors.push(`${host(url)}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (!res.ok) {
      // 403/429/5xx are endpoint-level refusals — try the next provider.
      errors.push(`${host(url)}: HTTP ${res.status}`);
      continue;
    }
    const json = await res.json() as { result?: T; error?: { message: string } };
    // A JSON-RPC error is an answer from the chain, not an endpoint failure.
    if (json.error) throw new Error(`Solana RPC ${method}: ${json.error.message}`);
    return json.result as T;
  }
  throw new Error(`Solana RPC ${method} failed on all endpoints (${errors.join("; ")})`);
}

function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}


async function deriveEd25519(seed: BufferSource, path: number[]): Promise<Keypair> {
  const masterKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("ed25519 seed"),
    { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
  );
  let key = new Uint8Array(await crypto.subtle.sign("HMAC", masterKey, seed));
  for (const index of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key.slice(0, 32), 1);
    new DataView(data.buffer).setUint32(33, index + 0x80000000, false);
    const hmacKey = await crypto.subtle.importKey(
      "raw", key.slice(32),
      { name: "HMAC", hash: "SHA-512" }, false, ["sign"],
    );
    key = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, data));
  }
  return Keypair.fromSeed(key.slice(0, 32));
}

/**
 * Every keypair a recovery phrase can plausibly map to, in the order wallets
 * use them: Phantom/Solflare accounts 1-5 (m/44'/501'/i'/0'), the legacy
 * Sollet-style path (m/44'/501'/i'), and the bare BIP39 seed.
 */
async function mnemonicCandidates(mnemonic: string): Promise<Keypair[]> {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error("Invalid recovery phrase");
  const seed = await mnemonicToSeedWebcrypto(mnemonic);
  const out: Keypair[] = [];
  const seedBuf = new Uint8Array(seed) as unknown as BufferSource;
  for (let i = 0; i < 5; i++) out.push(await deriveEd25519(seedBuf, [44, 501, i, 0]));
  for (let i = 0; i < 5; i++) out.push(await deriveEd25519(seedBuf, [44, 501, i]));
  out.push(Keypair.fromSeed(seed.slice(0, 32)));
  return out;
}

/** Words of a recovery phrase, or null when the secret is a raw key. */
function asMnemonic(secret: string): string | null {
  const words = secret.trim().toLowerCase().split(/\s+/);
  return [12, 15, 18, 21, 24].includes(words.length) ? words.join(" ") : null;
}

function keypairFromRawSecret(trimmed: string): Keypair {
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error("Invalid secret-key byte array");
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

/** All keypairs a secret can unlock (one entry for raw keys). */
export async function candidateKeypairs(secret: string): Promise<Keypair[]> {
  const trimmed = secret.trim();
  const mnemonic = asMnemonic(trimmed);
  return mnemonic ? mnemonicCandidates(mnemonic) : [keypairFromRawSecret(trimmed)];
}

/**
 * Resolve the signing keypair. When `expectedPublicKey` is given (the address
 * stored at import time), the matching derivation is returned so signing always
 * uses the account the desk shows.
 */
export async function keypairFromSecret(secret: string, expectedPublicKey?: string | null): Promise<Keypair> {
  const candidates = await candidateKeypairs(secret);
  if (expectedPublicKey) {
    const match = candidates.find(k => k.publicKey.toBase58() === expectedPublicKey);
    if (match) return match;
  }
  return candidates[0]!;
}

/** Pick the derivation that actually holds SOL, falling back to the first. */
export async function resolveFundedKeypair(secret: string): Promise<{ keypair: Keypair; sol: number }> {
  const candidates = await candidateKeypairs(secret);
  const balances = await Promise.all(candidates.map(async k => {
    try { return await solBalance(k.publicKey.toBase58()); } catch { return 0; }
  }));
  let best = 0;
  for (let i = 1; i < candidates.length; i++) if ((balances[i] ?? 0) > (balances[best] ?? 0)) best = i;
  return { keypair: candidates[best]!, sol: balances[best] ?? 0 };
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

/** Every SPL / Token-2022 balance the wallet actually holds, so the desk can
 *  show real memecoin holdings and not only the SOL balance. */
export async function listTokenHoldings(owner: string): Promise<
  Array<{ mint: string; amount: number; uiAmount: number; decimals: number }>
> {
  const programs = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",      // SPL Token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",      // Token-2022
  ];
  type Acc = { account: { data: { parsed: { info: {
    mint: string; tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
  } } } } };
  const out: Array<{ mint: string; amount: number; uiAmount: number; decimals: number }> = [];
  for (const programId of programs) {
    let r: { value?: Acc[] } | null = null;
    try {
      r = await rpc<{ value: Acc[] }>("getTokenAccountsByOwner",
        [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    } catch { continue; } // one program failing must not hide the other
    for (const acc of r?.value ?? []) {
      const info = acc?.account?.data?.parsed?.info;
      if (!info) continue;
      const ui = info.tokenAmount.uiAmount ?? Number(info.tokenAmount.amount) / 10 ** info.tokenAmount.decimals;
      if (!ui || ui <= 0) continue;
      out.push({
        mint: info.mint, amount: Number(info.tokenAmount.amount),
        uiAmount: ui, decimals: info.tokenAmount.decimals,
      });
    }
  }
  return out.sort((a, b) => b.uiAmount - a.uiAmount);
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
  secret: string; publicKey?: string | null; inputMint: string; outputMint: string; amountRaw: number; slippageBps: number;
}): Promise<{ signature: string; outAmount: number; priceImpactPct: number }> {
  const kp = await keypairFromSecret(opts.secret, opts.publicKey);
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
