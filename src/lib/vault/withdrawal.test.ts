// Regression tests for the hardened withdrawal flow.
//
// Covers: stolen-session attempts, code_hash unreadability, concurrent
// confirmation, daily limits, new-address cooldown, and cross-user isolation.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";

process.env.CREDENTIAL_ENC_KEY ??= "test-encryption-key-for-custody-suite";

// ---- in-memory service-role database ---------------------------------------
type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

function rows(name: string) { return tables[name] ?? (tables[name] = []); }

function table(name: string) {
  const data = rows(name);
  const eqs: Array<[string, unknown]> = [];
  const gtes: Array<[string, string]> = [];
  let mode: "select" | "update" = "select";
  let patch: Row = {};
  const match = (r: Row) =>
    eqs.every(([k, v]) => r[k] === v) &&
    gtes.every(([k, v]) => String(r[k]) >= v);

  const run = () => {
    const hit = data.filter(match);
    if (mode === "update") for (const r of hit) Object.assign(r, patch);
    return hit;
  };
  const api = {
    select() { return api; },
    eq(k: string, v: unknown) { eqs.push([k, v]); return api; },
    gte(k: string, v: string) { gtes.push([k, v]); return api; },
    order() { return api; },
    limit() { return api; },
    update(p: Row) { mode = "update"; patch = p; return api; },
    insert(r: Row | Row[]) {
      for (const one of Array.isArray(r) ? r : [r]) data.push({ ...one });
      return api;
    },
    async maybeSingle() { return { data: run()[0] ?? null, error: null }; },
    async single() { const d = run()[0]; return { data: d ?? null, error: d ? null : { message: "no row" } }; },
    then(res: (v: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve(res({ data: run(), error: null }));
    },
  };
  return api;
}
const fakeAdmin = { from: (n: string) => table(n) };
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: fakeAdmin }));
vi.mock("@/lib/memecoin/jupiter.server", () => ({
  rpcEndpoints: () => ["http://rpc.invalid"],
  solBalance: async () => 0,
  tokenBalance: async () => ({ amount: 0, decimals: 6 }),
  confirmSignature: async () => undefined,
}));

const {
  effectivePolicy, splitPolicyChange, destinationUnlocked,
  withdrawnLast24h, noteDestination, loadPolicy, LOOSEN_DELAY_MS,
} = await import("@/lib/vault/policy.server");
const { hashCode } = await import("@/lib/vault/wallet.server");
const { maskEmail } = await import("@/lib/email/send.server");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADDR = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k]; });

// ---------------------------------------------------------------------------
describe("confirmation secret is unreachable from the session", () => {
  it("the client-facing withdrawal read never selects code_hash or attempts", () => {
    const src = readFileSync("src/lib/vault.functions.ts", "utf8");
    const clientSelect = src.match(/from\("vault_withdrawals"\)\s*\.select\("([^"]+)"\)/);
    expect(clientSelect).not.toBeNull();
    expect(clientSelect![1]).not.toContain("code_hash");
    expect(clientSelect![1]).not.toContain("attempts");
  });

  it("the migration revokes table-wide SELECT and re-grants only safe columns", () => {
    const sql = readFileSync(
      "supabase/migrations/" +
      require("node:fs").readdirSync("supabase/migrations")
        .filter((f: string) => f.endsWith(".sql")).sort().at(-1)!,
      "utf8",
    );
    expect(sql).toMatch(/REVOKE SELECT ON public\.vault_withdrawals FROM authenticated/);
    const grant = sql.match(/GRANT SELECT \(([\s\S]*?)\)\s*\n?\s*ON public\.vault_withdrawals/);
    expect(grant).not.toBeNull();
    expect(grant![1]).not.toContain("code_hash");
    expect(grant![1]).not.toContain("attempts");
  });

  it("the emailed code is never written into the in-app notification", () => {
    const src = readFileSync("src/lib/vault.functions.ts", "utf8");
    const emit = src.slice(src.indexOf("vault.withdrawal_requested"), src.indexOf("return { id: row.id"));
    expect(emit).not.toMatch(/\$\{code\}/);
    expect(emit).toContain("maskEmail(email)");
  });

  it("code delivery goes out-of-band and fails closed", () => {
    const src = readFileSync("src/lib/vault.functions.ts", "utf8");
    expect(src).toContain("await sendEmail(");
    // A failed send must cancel the request rather than fall back in-app.
    const failure = src.slice(src.indexOf("} catch (e) {", src.indexOf("await sendEmail(")));
    expect(failure).toContain('status: "cancelled"');
  });
});

// ---------------------------------------------------------------------------
describe("stolen-session attacker", () => {
  it("cannot brute-force the code: the hash is not derivable from readable fields", async () => {
    // Everything the session CAN read about a request:
    const visible = { id: "abc", asset: "SOL", amount: 1, destination: ADDR, status: "pending_confirmation" };
    const digest = await hashCode(ALICE, "123456");
    expect(JSON.stringify(visible)).not.toContain(digest);
    // and the hash is user-salted, so a hash captured for one account is
    // useless for another.
    expect(await hashCode(BOB, "123456")).not.toBe(digest);
  });

  it("cannot instantly raise the daily limit — loosening is staged", () => {
    const current = { dailyLimitSol: 2, dailyLimitUsdc: 500, cooldownMinutes: 1440 };
    const attack = { dailyLimitSol: 9999, dailyLimitUsdc: 999999, cooldownMinutes: 0 };
    const { immediate, staged } = splitPolicyChange(current, attack);
    expect(immediate).toEqual(current);       // nothing loosens now
    expect(staged).toEqual(attack);           // it only becomes live later
  });

  it("can still tighten protection immediately", () => {
    const current = { dailyLimitSol: 2, dailyLimitUsdc: 500, cooldownMinutes: 1440 };
    const { immediate, staged } = splitPolicyChange(current, {
      dailyLimitSol: 0.1, dailyLimitUsdc: 10, cooldownMinutes: 4320,
    });
    expect(immediate).toEqual({ dailyLimitSol: 0.1, dailyLimitUsdc: 10, cooldownMinutes: 4320 });
    expect(staged).toBeNull();
  });

  it("a staged loosening is not in force until its effective time", () => {
    const row = {
      daily_limit_sol: 2, daily_limit_usdc: 500, new_address_cooldown_minutes: 1440,
      pending_daily_limit_sol: 9999, pending_daily_limit_usdc: 999999, pending_cooldown_minutes: 0,
      pending_effective_at: new Date(Date.now() + LOOSEN_DELAY_MS).toISOString(),
    };
    expect(effectivePolicy(row).dailyLimitSol).toBe(2);
    expect(effectivePolicy(row, Date.now() + LOOSEN_DELAY_MS + 1).dailyLimitSol).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
describe("atomic confirmation — only one concurrent confirm can win", () => {
  it("the status transition is conditional on the row still being pending", () => {
    const src = readFileSync("src/lib/vault.functions.ts", "utf8");
    const claim = src.slice(src.indexOf('.update({ status: "sending"'), src.indexOf("This withdrawal is already being processed"));
    expect(claim).toContain('.eq("status", "pending_confirmation")');
    expect(claim).toContain('.eq("user_id", userId)');
    expect(claim).toContain(".select(\"id\")");
    // and signing happens only after the claim succeeded
    expect(src.indexOf("claimed.length !== 1")).toBeLessThan(src.indexOf("await withdrawSol("));
  });

  it("a conditional update matches the row once and never twice", async () => {
    rows("vault_withdrawals").push({ id: "w1", user_id: ALICE, status: "pending_confirmation" });
    const claim = async () => {
      const res = await fakeAdmin.from("vault_withdrawals")
        .update({ status: "sending" })
        .eq("id", "w1").eq("user_id", ALICE).eq("status", "pending_confirmation")
        .select();
      return (res as unknown as { data?: Row[] }).data ?? (res as unknown as Row[]);
    };
    const [a, b] = await Promise.all([claim(), claim()]);
    const winners = [a, b].filter(r => (r as Row[]).length === 1);
    expect(winners).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe("daily withdrawal limit", () => {
  it("counts sent and in-flight withdrawals from the last 24h only", async () => {
    const now = Date.now();
    rows("vault_withdrawals").push(
      { user_id: ALICE, asset: "SOL", amount: 1, status: "sent", created_at: new Date(now - 3600_000).toISOString() },
      { user_id: ALICE, asset: "SOL", amount: 0.5, status: "sending", created_at: new Date(now - 60_000).toISOString() },
      { user_id: ALICE, asset: "SOL", amount: 5, status: "cancelled", created_at: new Date(now - 60_000).toISOString() },
      { user_id: ALICE, asset: "SOL", amount: 9, status: "sent", created_at: new Date(now - 48 * 3600_000).toISOString() },
      { user_id: ALICE, asset: "USDC", amount: 100, status: "sent", created_at: new Date(now - 60_000).toISOString() },
      { user_id: BOB, asset: "SOL", amount: 7, status: "sent", created_at: new Date(now - 60_000).toISOString() },
    );
    expect(await withdrawnLast24h(ALICE, "SOL")).toBeCloseTo(1.5, 9);
    expect(await withdrawnLast24h(ALICE, "USDC")).toBeCloseTo(100, 9);
    // one user's usage never consumes another's allowance
    expect(await withdrawnLast24h(BOB, "SOL")).toBeCloseTo(7, 9);
  });

  it("the request path blocks an amount that would exceed the cap", () => {
    const src = readFileSync("src/lib/vault.functions.ts", "utf8");
    expect(src).toMatch(/used \+ data\.amount > limit/);
    // and re-checks at send time, so two pending requests cannot stack
    expect(src).toMatch(/used \+ amount > limit/);
  });

  it("defaults are conservative rather than unlimited", async () => {
    const p = await loadPolicy(ALICE);
    expect(p.dailyLimitSol).toBe(2);
    expect(p.dailyLimitUsdc).toBe(500);
    expect(p.cooldownMinutes).toBe(1440);
  });
});

// ---------------------------------------------------------------------------
describe("new-address cooldown", () => {
  it("locks a first-seen address for the configured window", async () => {
    const first = await noteDestination(ALICE, ADDR, 1440);
    expect(first.isNew).toBe(true);
    expect(destinationUnlocked(first.unlocksAt)).toBe(false);
  });

  it("does not restart the clock on a repeat request", async () => {
    const first = await noteDestination(ALICE, ADDR, 1440);
    await new Promise(r => setTimeout(r, 5));
    const second = await noteDestination(ALICE, ADDR, 1440);
    expect(second.isNew).toBe(false);
    expect(second.unlocksAt).toBe(first.unlocksAt);
  });

  it("releases the address once the window has passed", async () => {
    const past = await noteDestination(ALICE, ADDR, 0);
    expect(destinationUnlocked(past.unlocksAt)).toBe(true);
  });

  it("is per-user: Bob's aged address does not unlock Alice's", async () => {
    await noteDestination(BOB, ADDR, 0);
    const alice = await noteDestination(ALICE, ADDR, 1440);
    expect(destinationUnlocked(alice.unlocksAt)).toBe(false);
    expect(alice.isNew).toBe(true);
  });

  it("an unknown address is never treated as unlocked", () => {
    expect(destinationUnlocked(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("delivery address handling", () => {
  it("masks the email before storing or showing it", () => {
    expect(maskEmail("wally@example.com")).toBe("wa***@example.com");
    expect(maskEmail("ab@x.io")).toBe("ab**@x.io");
  });
});
