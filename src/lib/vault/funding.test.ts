// Vault-as-funding-source tests.
//
// Proves the architecture the vault redesign promises:
//   * one unique vault address per user, never shared or reused
//   * the engine spends the VAULT balance, and ignores any linked wallet
//   * concurrent trades cannot spend the same SOL twice
//   * a failed trade releases its claim; a confirmed one consumes it
//   * a position row is only written after an on-chain confirmation
//   * reserved SOL cannot be withdrawn, and trading code has no withdrawal path
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

process.env.CREDENTIAL_ENC_KEY ??= "test-encryption-key-for-funding-suite";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {
  vault_wallets: [], vault_reservations: [], vault_deposits: [],
  vault_transactions: [], memecoin_positions: [], memecoin_wallets: [],
};

function table(name: string) {
  const rows = tables[name] ?? (tables[name] = []);
  const q = { filters: [] as Array<[string, unknown]> };
  const match = (r: Row) => q.filters.every(([k, v]) => r[k] === v);
  const api = {
    select() { return api; },
    eq(k: string, v: unknown) { q.filters.push([k, v]); return api; },
    in() { return api; },
    order() { return api; },
    limit() { return api; },
    async maybeSingle() { return { data: rows.find(match) ?? null, error: null }; },
    async single() { return { data: rows.find(match) ?? null, error: null }; },
    insert(row: Row) {
      rows.push(row);
      return Object.assign(
        Promise.resolve({ data: row, error: null }),
        { select: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) },
      );
    },
    then(res: (v: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve(res({ data: rows.filter(match), error: null }));
    },
  };
  return api;
}

/** Mirrors claim_vault_funds / release_vault_funds, including the atomicity. */
const fakeAdmin = {
  from: (name: string) => table(name),
  async rpc(fn: string, args: Record<string, unknown>) {
    if (fn === "claim_vault_funds") {
      const userId = args["_user_id"] as string;
      const amount = Number(args["_amount"]);
      const spendable = Number(args["_spendable"]);
      const reserved = tables.vault_reservations!
        .filter(r => r["user_id"] === userId && r["status"] === "active")
        .reduce((a, r) => a + Number(r["amount_sol"]), 0);
      const available = spendable - reserved;
      if (amount > available) {
        return { data: [{ id: null, granted: false, reserved, available }], error: null };
      }
      const id = `res-${tables.vault_reservations!.length + 1}`;
      tables.vault_reservations!.push({
        id, user_id: userId, amount_sol: amount, status: "active",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
      return { data: [{ id, granted: true, reserved: reserved + amount, available: available - amount }], error: null };
    }
    if (fn === "release_vault_funds") {
      const row = tables.vault_reservations!.find(
        r => r["id"] === args["_reservation_id"] && r["user_id"] === args["_user_id"] && r["status"] === "active",
      );
      if (!row) return { data: false, error: null };
      row["status"] = args["_status"];
      return { data: true, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  },
};

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeAdmin }));

const chain = { sol: 0, usdcRaw: 0 };
const swapCalls: Array<Record<string, unknown>> = [];
const swapBehaviour = { fail: false };
vi.mock("@/lib/memecoin/jupiter.server", () => ({
  rpcEndpoints: () => ["http://rpc.invalid"],
  solBalance: async () => chain.sol,
  tokenBalance: async () => ({ amount: chain.usdcRaw, decimals: 6 }),
  listTokenHoldings: async () => [],
  confirmSignature: async () => undefined,
  SOL_MINT: "So11111111111111111111111111111111111111112",
  swap: async (o: Record<string, unknown>) => {
    swapCalls.push(o);
    if (swapBehaviour.fail) throw new Error("swap failed on-chain");
    return { signature: "sig-confirmed", outAmount: 1234, priceImpactPct: 0.4 };
  },
}));

const { ensureVaultWallet, vaultBalances } = await import("@/lib/vault/wallet.server");
const {
  computeAvailableSol, computeSpendableSol, reserveVaultSol, releaseVaultSol,
  activeReservationsSol, FEE_RESERVE_SOL,
} = await import("@/lib/vault/funding.server");
const { buyCandidate } = await import("@/lib/memecoin/engine.server");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const db = fakeAdmin as never;

const settings = {
  buy_amount_sol: 0.5, slippage_bps: 100, max_open_positions: 3,
} as never;
const candidate = { mint: "MintAAA", symbol: "AAA", priceUsd: 0.01, score: 90 } as never;

beforeEach(() => {
  for (const k of Object.keys(tables)) tables[k] = [];
  chain.sol = 0;
  chain.usdcRaw = 0;
  swapCalls.length = 0;
  swapBehaviour.fail = false;
});

describe("per-user vault address", () => {
  it("gives each user a unique address and never reuses one", async () => {
    const a = await ensureVaultWallet(ALICE);
    const b = await ensureVaultWallet(BOB);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.publicKey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("returns the same address on every later call for that user", async () => {
    const first = await ensureVaultWallet(ALICE);
    const again = await ensureVaultWallet(ALICE);
    expect(again.publicKey).toBe(first.publicKey);
    expect(tables.vault_wallets).toHaveLength(1);
  });

  it("keeps one user's vault out of another user's reach", async () => {
    await ensureVaultWallet(ALICE);
    const bob = tables.vault_wallets!.find(r => r["user_id"] === BOB);
    expect(bob).toBeUndefined();
  });
});

describe("available balance accounting", () => {
  it("subtracts positions, in-flight claims and the fee reserve", () => {
    expect(computeAvailableSol({ sol: 2, positionsSol: 0.5, reservationsSol: 0.25 }))
      .toBeCloseTo(2 - 0.5 - 0.25 - FEE_RESERVE_SOL, 9);
  });

  it("never goes negative", () => {
    expect(computeAvailableSol({ sol: 0.001, positionsSol: 0, reservationsSol: 0 })).toBe(0);
  });

  it("reports pending claims in the balance summary", async () => {
    await ensureVaultWallet(ALICE);
    chain.sol = 3;
    await reserveVaultSol(ALICE, 1, computeSpendableSol(3, 0));
    const b = await vaultBalances(db, ALICE, "addr");
    expect(b.pendingSol).toBeCloseTo(1, 9);
    expect(b.availableSol).toBeCloseTo(3 - 1 - FEE_RESERVE_SOL, 9);
  });
});

describe("atomic reservations", () => {
  it("grants a claim within the spendable balance", async () => {
    const c = await reserveVaultSol(ALICE, 1, computeSpendableSol(2, 0));
    expect(c.granted).toBe(true);
    expect(c.id).toBeTruthy();
  });

  it("refuses a second claim that would overspend the same balance", async () => {
    const spendable = computeSpendableSol(1, 0);
    const first = await reserveVaultSol(ALICE, 0.8, spendable);
    const second = await reserveVaultSol(ALICE, 0.8, spendable);
    expect(first.granted).toBe(true);
    expect(second.granted).toBe(false);
    expect(second.id).toBeNull();
  });

  it("frees the balance again when a claim is released", async () => {
    const spendable = computeSpendableSol(1, 0);
    const first = await reserveVaultSol(ALICE, 0.8, spendable);
    await releaseVaultSol(ALICE, first.id!, "released");
    expect(await activeReservationsSol(ALICE)).toBe(0);
    expect((await reserveVaultSol(ALICE, 0.8, spendable)).granted).toBe(true);
  });

  it("keeps a consumed claim out of the active pool", async () => {
    const c = await reserveVaultSol(ALICE, 0.4, computeSpendableSol(1, 0));
    await releaseVaultSol(ALICE, c.id!, "consumed");
    expect(await activeReservationsSol(ALICE)).toBe(0);
  });

  it("will not let one user release another user's claim", async () => {
    const c = await reserveVaultSol(ALICE, 0.4, computeSpendableSol(1, 0));
    expect(await releaseVaultSol(BOB, c.id!, "released")).toBe(false);
    expect(await activeReservationsSol(ALICE)).toBeCloseTo(0.4, 9);
  });

  it("counts claims per user, never pooled across users", async () => {
    await reserveVaultSol(ALICE, 0.4, computeSpendableSol(1, 0));
    expect(await activeReservationsSol(BOB)).toBe(0);
  });
});

describe("the engine funds trades from the vault", () => {
  it("spends the vault balance and signs with the vault key", async () => {
    const wallet = await ensureVaultWallet(ALICE);
    chain.sol = 2;
    const res = await buyCandidate(db, ALICE, candidate, settings);
    expect(swapCalls).toHaveLength(1);
    expect(swapCalls[0]!["publicKey"]).toBe(wallet.publicKey);
    expect(res.signature).toBe("sig-confirmed");
  });

  it("ignores a linked wallet entirely — an unfunded link does not block trading", async () => {
    await ensureVaultWallet(ALICE);
    tables.memecoin_wallets!.push({ user_id: ALICE, public_key: "LinkedWallet", phantom_address: "LinkedWallet" });
    chain.sol = 2;
    await expect(buyCandidate(db, ALICE, candidate, settings)).resolves.toBeTruthy();
    expect(swapCalls[0]!["publicKey"]).not.toBe("LinkedWallet");
  });

  it("refuses to trade when no vault exists yet", async () => {
    chain.sol = 5;
    await expect(buyCandidate(db, ALICE, candidate, settings)).rejects.toThrow(/vault is not ready/i);
  });

  it("refuses to trade beyond the vault's available balance", async () => {
    await ensureVaultWallet(ALICE);
    chain.sol = 0.2;
    await expect(buyCandidate(db, ALICE, candidate, settings)).rejects.toThrow(/available in your vault/i);
    expect(swapCalls).toHaveLength(0);
  });

  it("cannot open two trades against the same unspent SOL", async () => {
    await ensureVaultWallet(ALICE);
    chain.sol = 0.6; // enough for exactly one 0.5 SOL buy
    const results = await Promise.allSettled([
      buyCandidate(db, ALICE, candidate, settings),
      buyCandidate(db, ALICE, candidate, settings),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(swapCalls).toHaveLength(1);
  });

  it("releases the claim and writes no position when the swap fails", async () => {
    await ensureVaultWallet(ALICE);
    chain.sol = 2;
    swapBehaviour.fail = true;
    await expect(buyCandidate(db, ALICE, candidate, settings)).rejects.toThrow(/swap failed/);
    expect(tables.memecoin_positions).toHaveLength(0);
    expect(await activeReservationsSol(ALICE)).toBe(0);
  });

  it("creates the position only after a confirmed transaction, then consumes the claim", async () => {
    await ensureVaultWallet(ALICE);
    chain.sol = 2;
    await buyCandidate(db, ALICE, candidate, settings);
    expect(tables.memecoin_positions).toHaveLength(1);
    expect(tables.memecoin_positions![0]!["entry_tx"]).toBe("sig-confirmed");
    expect(await activeReservationsSol(ALICE)).toBe(0);
    expect(tables.vault_reservations![0]!["status"]).toBe("consumed");
  });
});

describe("withdrawal authority stays out of the trading path", () => {
  const engineSrc = readFileSync("src/lib/memecoin/engine.server.ts", "utf8");
  const scannerSrc = readFileSync("src/lib/memecoin/scanner.server.ts", "utf8");

  it("the sniper engine never imports a withdrawal function", () => {
    expect(engineSrc).not.toMatch(/withdrawSol|withdrawUsdc|confirmWithdrawal|requestWithdrawal/);
    expect(scannerSrc).not.toMatch(/withdrawSol|withdrawUsdc/);
  });

  it("reserved SOL is excluded from the withdrawable balance", async () => {
    await ensureVaultWallet(ALICE);
    chain.sol = 2;
    tables.memecoin_positions!.push({ user_id: ALICE, status: "open", amount_sol: 1 });
    await reserveVaultSol(ALICE, 0.5, computeSpendableSol(2, 1));
    const b = await vaultBalances(db, ALICE, "addr");
    expect(b.availableSol).toBeCloseTo(2 - 1 - 0.5 - FEE_RESERVE_SOL, 9);
  });

  it("withdrawals still require the emailed confirmation code", () => {
    const src = readFileSync("src/lib/vault.functions.ts", "utf8");
    expect(src).toMatch(/code_hash: await hashCode/);
    expect(src).toMatch(/pending_confirmation/);
  });
});
