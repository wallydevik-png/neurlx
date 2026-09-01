// Regression tests for Jupiter swap verification.
//
// The threat model: the aggregator response is untrusted. Every test below
// builds a REAL transaction and asserts the guard's verdict — a legitimate
// swap is accepted, and each drain vector is rejected.
import { describe, it, expect } from "vitest";
import {
  Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createApproveInstruction, createSetAuthorityInstruction, createBurnInstruction,
  createCloseAccountInstruction, createTransferInstruction, AuthorityType,
} from "@solana/spl-token";
import {
  inspectSwapTransaction, assertSimulationDeltas, minOutputFromQuote, SwapRejected,
  NATIVE_SOL_MINT, JUPITER_V6, FEE_AND_RENT_ALLOWANCE_LAMPORTS,
} from "./swapGuard";

const owner = Keypair.generate();
const attacker = Keypair.generate();
const OUT_MINT = "8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn"; // arbitrary memecoin
const AMOUNT_LAMPORTS = 50_000_000; // 0.05 SOL

const intent = {
  owner: owner.publicKey.toBase58(),
  inputMint: NATIVE_SOL_MINT,
  outputMint: OUT_MINT,
  maxInputRaw: AMOUNT_LAMPORTS,
  minOutputRaw: 1_000_000,
};

const BLOCKHASH = "11111111111111111111111111111111";

type Ix = ConstructorParameters<typeof TransactionMessage>[0]["instructions"];

function tx(ixs: Ix, payer = owner.publicKey) {
  const message = new TransactionMessage({
    payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}


/** A realistic Jupiter route instruction: opaque data, Jupiter program id. */
function jupiterRoute() {
  return {
    programId: new PublicKey(JUPITER_V6),
    keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(OUT_MINT), isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0xe5, 0x17, 0x1b, 0xd9, 0x00, 0x11, 0x22, 0x33]),
  };
}

function legitimateSwapTx() {
  return tx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    // wSOL wrapping: lamports move to the user's own temp account.
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: AMOUNT_LAMPORTS,
    }),
    jupiterRoute(),
  ]);
}

describe("static inspection — legitimate swaps", () => {
  it("accepts a normal Jupiter swap", () => {
    expect(() => inspectSwapTransaction(legitimateSwapTx(), intent)).not.toThrow();
  });

  it("accepts a token-input swap that sells no more than the position", () => {
    const tokenIntent = { ...intent, inputMint: OUT_MINT, outputMint: NATIVE_SOL_MINT, maxInputRaw: 5_000 };
    const t = tx([
      jupiterRoute(),
      createTransferInstruction(
        Keypair.generate().publicKey, Keypair.generate().publicKey, owner.publicKey, 5_000,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, tokenIntent)).not.toThrow();
  });
});

describe("static inspection — malicious transactions are rejected", () => {
  it("rejects a transaction with no Jupiter instruction at all", () => {
    const t = tx([SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: attacker.publicKey, lamports: 1_000,
    })]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/no Jupiter swap instruction/);
  });

  it("rejects a swap that drains extra SOL alongside the trade", () => {
    const t = tx([
      jupiterRoute(),
      SystemProgram.transfer({
        fromPubkey: owner.publicKey, toPubkey: attacker.publicKey, lamports: 900_000_000,
      }),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(SwapRejected);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/lamports out, above/);
  });

  it("rejects a delegation (Approve) hidden in the swap", () => {
    const t = tx([
      jupiterRoute(),
      createApproveInstruction(
        Keypair.generate().publicKey, attacker.publicKey, owner.publicKey, 10n ** 18n,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/delegates spending authority/);
  });

  it("rejects an account-ownership handover (SetAuthority)", () => {
    const t = tx([
      jupiterRoute(),
      createSetAuthorityInstruction(
        Keypair.generate().publicKey, owner.publicKey,
        AuthorityType.AccountOwner, attacker.publicKey,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/SetAuthority/);
  });

  it("rejects a burn", () => {
    const t = tx([
      jupiterRoute(),
      createBurnInstruction(
        Keypair.generate().publicKey, new PublicKey(OUT_MINT), owner.publicKey, 1_000,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/Burn/);
  });

  it("rejects closing a token account into the attacker's wallet", () => {
    const t = tx([
      jupiterRoute(),
      createCloseAccountInstruction(
        Keypair.generate().publicKey, attacker.publicKey, owner.publicKey,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/rent somewhere else/);
  });

  it("allows closing the wrapped-SOL account back to the owner", () => {
    const t = tx([
      jupiterRoute(),
      createCloseAccountInstruction(
        Keypair.generate().publicKey, owner.publicKey, owner.publicKey,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).not.toThrow();
  });

  it("rejects a token transfer larger than the amount being traded", () => {
    const tokenIntent = { ...intent, inputMint: OUT_MINT, maxInputRaw: 5_000 };
    const t = tx([
      jupiterRoute(),
      createTransferInstruction(
        Keypair.generate().publicKey, attacker.publicKey, owner.publicKey, 5_000_000,
      ),
    ]);
    expect(() => inspectSwapTransaction(t, tokenIntent)).toThrow(/more than the 5000 being traded/);
  });

  it("rejects an unknown program, even next to a real Jupiter instruction", () => {
    const t = tx([
      jupiterRoute(),
      {
        programId: attacker.publicKey,
        keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([1, 2, 3]),
      },
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/unexpected program/);
  });

  it("rejects a transaction whose fee payer is not this vault", () => {
    const t = tx([jupiterRoute()], attacker.publicKey);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/fee payer \/ signer is not this wallet/);
  });

  it("rejects a transaction that demands a second signer", () => {
    const t = tx([
      jupiterRoute(),
      SystemProgram.transfer({
        fromPubkey: attacker.publicKey, toPubkey: owner.publicKey, lamports: 1,
      }),
    ]);
    expect(() => inspectSwapTransaction(t, intent)).toThrow(/requires 2 signers/);
  });
});

describe("simulated balance deltas — the load-bearing check", () => {
  const base = { lamportsBefore: 1_000_000_000, outputBefore: 0 };

  it("accepts a swap whose simulated effect matches the quote", () => {
    expect(() => assertSimulationDeltas(intent, {
      ...base,
      lamportsAfter: 1_000_000_000 - AMOUNT_LAMPORTS - 5_000,
      outputAfter: 1_200_000,
    })).not.toThrow();
  });

  it("rejects a swap that takes more SOL than the trade allows", () => {
    expect(() => assertSimulationDeltas(intent, {
      ...base,
      lamportsAfter: 1_000_000_000 - AMOUNT_LAMPORTS - FEE_AND_RENT_ALLOWANCE_LAMPORTS - 1,
      outputAfter: 5_000_000,
    })).toThrow(/lamports leaving the wallet, above/);
  });

  it("rejects a swap that delivers less than the quoted minimum", () => {
    expect(() => assertSimulationDeltas(intent, {
      ...base,
      lamportsAfter: 1_000_000_000 - AMOUNT_LAMPORTS,
      outputAfter: 999_999,
    })).toThrow(/below the 1000000 minimum/);
  });

  it("rejects a swap that pays out nothing at all (pure theft)", () => {
    expect(() => assertSimulationDeltas(intent, {
      ...base, lamportsAfter: 1_000_000_000 - AMOUNT_LAMPORTS, outputAfter: 0,
    })).toThrow(SwapRejected);
  });

  it("rejects selling more of the input token than the position holds", () => {
    const sellIntent = {
      ...intent, inputMint: OUT_MINT, outputMint: NATIVE_SOL_MINT,
      maxInputRaw: 1_000, minOutputRaw: 10_000,
    };
    expect(() => assertSimulationDeltas(sellIntent, {
      lamportsBefore: 1_000_000_000, lamportsAfter: 1_000_020_000,
      outputBefore: 0, outputAfter: 0,
      inputBefore: 500_000, inputAfter: 0,
    })).toThrow(/above the 1000 being sold/);
  });

  it("counts SOL proceeds correctly when selling back to SOL", () => {
    const sellIntent = {
      ...intent, inputMint: OUT_MINT, outputMint: NATIVE_SOL_MINT,
      maxInputRaw: 1_000, minOutputRaw: 10_000,
    };
    expect(() => assertSimulationDeltas(sellIntent, {
      lamportsBefore: 1_000_000_000, lamportsAfter: 1_000_050_000,
      outputBefore: 0, outputAfter: 0,
      inputBefore: 1_000, inputAfter: 0,
    })).not.toThrow();
  });
});

describe("quote bounds", () => {
  it("derives the minimum acceptable output from the slippage tolerance", () => {
    expect(minOutputFromQuote(1_000_000, 300)).toBe(970_000);
    expect(minOutputFromQuote(1_000_000, 0)).toBe(1_000_000);
  });
});

void build;
