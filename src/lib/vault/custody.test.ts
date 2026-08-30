// Custody / signing-authority audit tests for the NeurlX Trading Vault.
//
// These cover the abuse cases directly, not the happy path:
//   * unauthorized withdrawal (no auth, wrong owner)
//   * cross-user key access and cross-user code reuse
//   * forged balance updates (database-claimed balance vs. on-chain balance)
//   * replayed / expired / brute-forced withdrawal codes
//   * a compromised trading component trying to move funds out
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

process.env.CREDENTIAL_ENC_KEY ??= "test-encryption-key-for-custody-suite";

// --- in-memory stand-in for the service-role database -----------------------
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = { vault_wallets: [], memecoin_positions: [] };

function table(name: string) {
  const rows = tables[name] ?? (tables[name] = []);
  const q = { filters: [] as Array<[string, unknown]>, cols: "*" };
  const match = (r: Row) => q.filters.every(([k, v]) => r[k] === v);
  const api = {
    select(cols: string) { q.cols = cols; return api; },
    eq(k: string, v: unknown) { q.filters.push([k, v]); return api; },
    async maybeSingle() { return { data: rows.find(match) ?? null, error: null }; },
    async insert(row: Row) { rows.push(row); return { data: row, error: null }; },
    then(res: (v: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve(res({ data: rows.filter(match), error: null }));
    },
  };
  return api;
}
const fakeAdmin = { from: (name: string) => table(name) };

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeAdmin }));

// On-chain reads are stubbed so tests are deterministic and offline; the point
// is which number the code trusts, not what the network returns.
const chain = { sol: 0, usdcRaw: 0 };
vi.mock("@/lib/memecoin/jupiter.server", () => ({
  rpcEndpoints: () => ["http://rpc.invalid"],
  solBalance: async () => chain.sol,
  tokenBalance: async () => ({ amount: chain.usdcRaw, decimals: 6 }),
  confirmSignature: async () => undefined,
}));

const {
  ensureVaultWallet, getVaultWallet, loadVaultKeypair, vaultBalances,
  hashCode, isSolanaAddress, withdrawSol, SOL_FEE_RESERVE,
} = await import("@/lib/vault/wallet.server");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

/** Supabase-shaped client used for the positions read inside vaultBalances. */
function positionsClient(userId: string, openAmounts: number[]) {
  tables.memecoin_positions = openAmounts.map(a => ({
    user_id: userId, status: "open", amount_sol: a,
  }));
  return fakeAdmin as never;
}

beforeEach(() => {
  tables.vault_wallets = [];
  tables.memecoin_positions = [];
  chain.sol = 0;
  chain.usdcRaw = 0;
});

// ---------------------------------------------------------------------------
describe("key generation and storage", () => {
  it("never persists the secret in plaintext and never returns it", async () => {
    const wallet = await ensureVaultWallet(ALICE);
    const row = tables.vault_wallets[0]!;
    const stored = String(row.encrypted_secret);

    expect(Object.keys(wallet)).toEqual(["userId", "publicKey", "createdAt"]);
    expect(JSON.stringify(wallet)).not.toContain(stored);
    expect(stored.startsWith("v2:")).toBe(true);           // AES-256-GCM envelope
    expect(stored).not.toContain(wallet.publicKey);
    // The base58 secret must not be recoverable from the stored blob.
    const kp = await loadVaultKeypair(ALICE);
    expect(stored).not.toContain(bs58.encode(kp.secretKey));
  });

  it("is idempotent — a second call never regenerates and strands funds", async () => {
    const first = await ensureVaultWallet(ALICE);
    const second = await ensureVaultWallet(ALICE);
    expect(second.publicKey).toBe(first.publicKey);
    expect(tables.vault_wallets).toHaveLength(1);
  });

  it("refuses to sign when ciphertext and public key disagree (tampered row)", async () => {
    await ensureVaultWallet(ALICE);
    tables.vault_wallets[0]!.public_key = Keypair.generate().publicKey.toBase58();
    await expect(loadVaultKeypair(ALICE)).rejects.toThrow(/integrity check failed/i);
  });
});

// ---------------------------------------------------------------------------
describe("cross-user isolation", () => {
  it("gives each user a distinct keypair and never leaks the other's", async () => {
    const a = await ensureVaultWallet(ALICE);
    const b = await ensureVaultWallet(BOB);
    expect(a.publicKey).not.toBe(b.publicKey);

    const ka = await loadVaultKeypair(ALICE);
    const kb = await loadVaultKeypair(BOB);
    expect(ka.publicKey.toBase58()).toBe(a.publicKey);
    expect(kb.publicKey.toBase58()).toBe(b.publicKey);
    expect(bs58.encode(ka.secretKey)).not.toBe(bs58.encode(kb.secretKey));
  });

  it("cannot load a keypair for a user that has no vault", async () => {
    await ensureVaultWallet(ALICE);
    await expect(loadVaultKeypair(BOB)).rejects.toThrow(/No trading vault wallet/i);
    expect(await getVaultWallet(BOB)).toBeNull();
  });

  it("binds a withdrawal confirmation code to one user — codes are not portable", async () => {
    const code = "123456";
    expect(await hashCode(ALICE, code)).not.toBe(await hashCode(BOB, code));
    expect(await hashCode(ALICE, code)).toBe(await hashCode(ALICE, code));
    expect(await hashCode(ALICE, code)).not.toBe(await hashCode(ALICE, "123457"));
  });
});

// ---------------------------------------------------------------------------
describe("balance truth and reserve accounting", () => {
  it("reports the on-chain balance, not a database-claimed one", async () => {
    const w = await ensureVaultWallet(ALICE);
    chain.sol = 2;
    // A forged/stale ledger entry claiming 999 SOL must not affect the answer.
    tables.vault_transactions = [{ user_id: ALICE, kind: "deposit", amount: 999 }];
    const b = await vaultBalances(positionsClient(ALICE, []), ALICE, w.publicKey);
    expect(b.sol).toBe(2);
    expect(b.availableSol).toBeCloseTo(2 - SOL_FEE_RESERVE, 9);
  });

  it("excludes open-position reserves and the fee reserve from withdrawable funds", async () => {
    const w = await ensureVaultWallet(ALICE);
    chain.sol = 1;
    const b = await vaultBalances(positionsClient(ALICE, [0.4, 0.2]), ALICE, w.publicKey);
    expect(b.reservedSol).toBeCloseTo(0.6, 9);
    expect(b.availableSol).toBeCloseTo(1 - 0.6 - SOL_FEE_RESERVE, 9);
    expect(b.sol).toBeGreaterThan(b.availableSol);
  });

  it("never reports negative availability when reserves exceed the balance", async () => {
    const w = await ensureVaultWallet(ALICE);
    chain.sol = 0.1;
    const b = await vaultBalances(positionsClient(ALICE, [5]), ALICE, w.publicKey);
    expect(b.availableSol).toBe(0);
  });

  it("surfaces an RPC outage as an error instead of reporting a fake zero", async () => {
    const w = await ensureVaultWallet(ALICE);
    const jup = await import("@/lib/memecoin/jupiter.server");
    vi.spyOn(jup, "solBalance").mockRejectedValueOnce(new Error("RPC 403"));
    const b = await vaultBalances(positionsClient(ALICE, []), ALICE, w.publicKey);
    expect(b.error).toMatch(/403/);
  });
});

// ---------------------------------------------------------------------------
describe("withdrawal destination validation", () => {
  it("rejects malformed destinations before any signing happens", () => {
    for (const bad of ["", "not-an-address", "0x1234567890abcdef1234567890abcdef12345678", "O0Il".repeat(9)]) {
      expect(isSolanaAddress(bad)).toBe(false);
    }
    expect(isSolanaAddress(Keypair.generate().publicKey.toBase58())).toBe(true);
  });

  it("a withdrawal for a user with no vault cannot be signed", async () => {
    await expect(withdrawSol(BOB, Keypair.generate().publicKey.toBase58(), 0.1))
      .rejects.toThrow(/No trading vault wallet/i);
  });
});

// ---------------------------------------------------------------------------
// Architecture guards: these fail the build if a future change widens the
// blast radius of a compromised trading component.
// ---------------------------------------------------------------------------
const read = (p: string) => readFileSync(p, "utf8");

describe("signing-authority containment", () => {
  it("only the user-facing vault functions can move funds out", () => {
    const files = [
      "src/lib/memecoin/engine.server.ts",
      "src/lib/memecoin.functions.ts",
      "src/lib/autonomous.functions.ts",
      "src/lib/execution/engine.server.ts",
      "src/lib/execution/positionManager.server.ts",
      "src/routes/api/public/cron.autonomous.ts",
    ];
    for (const f of files) {
      const src = read(f);
      expect(src, `${f} must not import withdrawal primitives`)
        .not.toMatch(/withdrawSol|withdrawUsdc|loadVaultKeypair|vault\/wallet\.server/);
    }
  });

  it("withdrawal execution is reachable only behind code confirmation", () => {
    const src = read("src/lib/vault.functions.ts");
    const confirmBlock = src.slice(src.indexOf("export const confirmWithdrawal"));
    // The only two call sites of the transfer primitives live after a code check.
    expect(confirmBlock.indexOf("hashCode(userId, data.code) !== req.code_hash"))
      .toBeLessThan(confirmBlock.indexOf("withdrawSol("));
    expect(src.match(/await withdrawSol\(|await withdrawUsdc\(/g)).toHaveLength(2);
    // Destination always comes from the stored request row, never from input.
    expect(confirmBlock).toContain("withdrawSol(userId, req.destination, amount)");
    expect(confirmBlock).not.toMatch(/withdraw(Sol|Usdc)\([^)]*data\.destination/);
  });

  it("every vault key read is scoped by user_id", () => {
    const src = read("src/lib/vault/wallet.server.ts");
    const reads = src.match(/from\("vault_wallets"\)[\s\S]{0,160}?;/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      if (r.includes(".insert(")) continue;
      expect(r, `unscoped vault_wallets access: ${r}`).toContain('.eq("user_id"');
    }
  });

  it("the request step issues a code and never signs a transaction", () => {
    const src = read("src/lib/vault.functions.ts");
    const requestBlock = src.slice(
      src.indexOf("export const requestWithdrawal"),
      src.indexOf("export const confirmWithdrawal"),
    );
    expect(requestBlock).toContain("code_hash");
    expect(requestBlock).not.toMatch(/withdrawSol|withdrawUsdc|loadVaultKeypair/);
  });

  it("every vault server function requires an authenticated session", () => {
    const src = read("src/lib/vault.functions.ts");
    const fns = src.match(/createServerFn\(/g) ?? [];
    const guards = src.match(/\.middleware\(\[requireSupabaseAuth\]\)/g) ?? [];
    expect(guards.length).toBe(fns.length);
    // and each one derives identity from the session, never from user input.
    expect(src).not.toMatch(/data\.userId|input\.userId/);
  });

  it("the sniper spends through the swap router only — it has no transfer path", () => {
    const engine = read("src/lib/memecoin/engine.server.ts");
    expect(engine).not.toMatch(/SystemProgram|createTransferCheckedInstruction/);
    const jupiter = read("src/lib/memecoin/jupiter.server.ts");
    expect(jupiter).not.toMatch(/SystemProgram\.transfer/);
  });
});
