// Swap transaction verification.
//
// Jupiter returns a fully-built, opaque transaction. Signing it blind means
// the aggregator (or anyone who can impersonate it — DNS, TLS, a compromised
// build) can hand back a transaction that drains the wallet, and the vault
// would sign it. This module makes signing conditional on the transaction
// demonstrably matching the trade we asked for.
//
// Two independent layers, both required:
//   1. Static inspection (this file, `inspectSwapTransaction`): the account
//      and instruction shape must be a swap and nothing else.
//   2. Simulated balance deltas (`assertSimulationDeltas`): the actual value
//      movement the transaction produces must be within the intended bounds.
//
// A program allowlist alone is deliberately NOT considered sufficient — the
// Jupiter program can move arbitrary amounts, so the amount/delta checks in
// layer 2 are the load-bearing part.
import type { VersionedTransaction } from "@solana/web3.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Programs a Jupiter swap may legitimately invoke at the top level. */
export const ALLOWED_PROGRAMS = new Set([
  SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
  ATA_PROGRAM, MEMO_PROGRAM, JUPITER_V6,
]);

/** Lamports allowed to leave beyond the traded amount: fees + ATA rent. */
export const FEE_AND_RENT_ALLOWANCE_LAMPORTS = 10_000_000; // 0.01 SOL

export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";

// SPL Token instruction discriminants that hand spending authority away or
// destroy value. None of them belong in a swap the user asked for.
const FORBIDDEN_TOKEN_IX: Record<number, string> = {
  4: "Approve (delegates spending authority)",
  6: "SetAuthority (transfers ownership of the token account)",
  8: "Burn",
  13: "ApproveChecked (delegates spending authority)",
  15: "BurnChecked",
};
const TOKEN_TRANSFER = 3;
const TOKEN_TRANSFER_CHECKED = 12;
const TOKEN_CLOSE_ACCOUNT = 9;

const SYSTEM_TRANSFER = 2;
const SYSTEM_TRANSFER_WITH_SEED = 11;

export interface SwapIntent {
  /** The vault's public key — the only account allowed to sign or be debited. */
  owner: string;
  inputMint: string;
  outputMint: string;
  /** Upper bound on what may leave the wallet, in the input mint's raw units. */
  maxInputRaw: number;
  /** Lower bound on what must arrive, in the output mint's raw units. */
  minOutputRaw: number;
}

export class SwapRejected extends Error {
  constructor(reason: string) {
    super(`Refusing to sign this swap — ${reason}`);
    this.name = "SwapRejected";
  }
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i] ?? 0);
  return v;
}

/**
 * Layer 1 — structural inspection. Throws `SwapRejected` on anything that is
 * not recognisably the requested swap.
 */
export function inspectSwapTransaction(tx: VersionedTransaction, intent: SwapIntent): void {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map(k => k.toBase58());

  // Only the vault may sign. An extra required signer means the transaction
  // was built to also move somebody else's (or a second) account.
  if (msg.header.numRequiredSignatures !== 1) {
    throw new SwapRejected(`it requires ${msg.header.numRequiredSignatures} signers, expected 1`);
  }
  if (keys[0] !== intent.owner) {
    throw new SwapRejected("the fee payer / signer is not this wallet");
  }

  const isSolInput = intent.inputMint === NATIVE_SOL_MINT;
  let lamportsOut = 0n;
  let sawSwapProgram = false;

  for (const ix of msg.compiledInstructions) {
    const programId = keys[ix.programIdIndex];
    if (!programId) {
      // Program pulled in from an address lookup table: we cannot see what it
      // is, so we cannot vouch for it.
      throw new SwapRejected("an instruction targets a program hidden behind a lookup table");
    }
    if (!ALLOWED_PROGRAMS.has(programId)) {
      throw new SwapRejected(`it invokes an unexpected program (${programId})`);
    }
    if (programId === JUPITER_V6) sawSwapProgram = true;

    const data = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data);

    if (programId === SYSTEM_PROGRAM && data.length >= 4) {
      const kind = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
      if (kind === SYSTEM_TRANSFER || kind === SYSTEM_TRANSFER_WITH_SEED) {
        const source = keys[ix.accountKeyIndexes[0] ?? -1];
        if (source === intent.owner && data.length >= 12) lamportsOut += readU64LE(data, 4);
      }
    }

    if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
      const kind = data[0];
      if (kind !== undefined && FORBIDDEN_TOKEN_IX[kind]) {
        throw new SwapRejected(`it contains a token ${FORBIDDEN_TOKEN_IX[kind]} instruction`);
      }
      if (kind === TOKEN_CLOSE_ACCOUNT) {
        const destination = keys[ix.accountKeyIndexes[1] ?? -1];
        if (destination !== intent.owner) {
          throw new SwapRejected("it closes a token account and sends the rent somewhere else");
        }
      }
      if (kind === TOKEN_TRANSFER || kind === TOKEN_TRANSFER_CHECKED) {
        const amount = readU64LE(data, 1);
        if (amount > BigInt(Math.floor(intent.maxInputRaw))) {
          throw new SwapRejected(
            `it moves ${amount} raw token units, more than the ${Math.floor(intent.maxInputRaw)} being traded`,
          );
        }
      }
    }
  }

  const lamportCap = BigInt(
    (isSolInput ? Math.floor(intent.maxInputRaw) : 0) + FEE_AND_RENT_ALLOWANCE_LAMPORTS,
  );
  if (lamportsOut > lamportCap) {
    throw new SwapRejected(`it sends ${lamportsOut} lamports out, above the ${lamportCap} allowed for this trade`);
  }
  if (!sawSwapProgram) {
    throw new SwapRejected("it contains no Jupiter swap instruction");
  }
}

export interface BalanceDeltaInput {
  /** Lamports held by the owner before / after simulation. */
  lamportsBefore: number;
  lamportsAfter: number;
  /** Raw units of the OUTPUT mint held by the owner before / after. */
  outputBefore: number;
  outputAfter: number;
  /** Raw units of the INPUT mint (SPL inputs only) before / after. */
  inputBefore?: number;
  inputAfter?: number;
}

/**
 * Layer 2 — the transaction must produce the value movement we intended.
 * This is what makes the guard meaningful: no allowlisted program can quietly
 * take more than `maxInputRaw` or deliver less than `minOutputRaw`.
 */
export function assertSimulationDeltas(intent: SwapIntent, b: BalanceDeltaInput): void {
  const isSolInput = intent.inputMint === NATIVE_SOL_MINT;
  const lamportsSpent = b.lamportsBefore - b.lamportsAfter;
  const lamportCap = (isSolInput ? Math.floor(intent.maxInputRaw) : 0) + FEE_AND_RENT_ALLOWANCE_LAMPORTS;
  if (lamportsSpent > lamportCap) {
    throw new SwapRejected(
      `simulation shows ${lamportsSpent} lamports leaving the wallet, above the ${lamportCap} this trade allows`,
    );
  }

  if (!isSolInput && b.inputBefore != null && b.inputAfter != null) {
    const spent = b.inputBefore - b.inputAfter;
    if (spent > Math.floor(intent.maxInputRaw)) {
      throw new SwapRejected(
        `simulation spends ${spent} raw units of the input token, above the ${Math.floor(intent.maxInputRaw)} being sold`,
      );
    }
  }

  const received = b.outputAfter - b.outputBefore;
  // For a SOL-output swap the proceeds land as lamports, so a negative
  // lamport spend (net gain) is the receipt.
  const receivedEffective = intent.outputMint === NATIVE_SOL_MINT ? -lamportsSpent : received;
  if (receivedEffective < Math.floor(intent.minOutputRaw)) {
    throw new SwapRejected(
      `simulation delivers ${receivedEffective} raw units, below the ${Math.floor(intent.minOutputRaw)} minimum for this quote`,
    );
  }
}

/** Worst acceptable output for a quote, given slippage tolerance. */
export function minOutputFromQuote(outAmount: number, slippageBps: number): number {
  return Math.floor(outAmount * (1 - Math.min(Math.max(slippageBps, 0), 10_000) / 10_000));
}
