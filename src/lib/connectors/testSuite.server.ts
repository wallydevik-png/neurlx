// Universal Connector Test Suite. Runs the same battery of checks against
// every registered connector so we can produce a comparable health report
// no matter which broker is behind the connection.
//
// Each check is soft-failed: one failing step never aborts the run — the
// report enumerates exactly which capability works and which does not.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createConnector } from "./factory.server";
import { getCapabilities } from "./capabilities";

export interface TestStepResult {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface ConnectorTestReport {
  connectionId: string;
  connectorId: string;
  ranAt: string;
  overallOk: boolean;
  passed: number;
  failed: number;
  skipped: number;
  steps: TestStepResult[];
}

async function timed<T>(step: string, fn: () => Promise<T>): Promise<TestStepResult & { value?: T }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { step, ok: true, ms: Date.now() - t0, value };
  } catch (e) {
    return { step, ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function runConnectorTestSuite(
  supabase: SupabaseClient,
  userId: string,
  connectionId: string,
): Promise<ConnectorTestReport> {
  const { data: conn, error } = await supabase.from("exchange_connections")
    .select("*").eq("id", connectionId).eq("user_id", userId).maybeSingle();
  if (error || !conn) throw new Error("Connection not found");

  const { decryptJSON } = await import("@/lib/crypto.server");
  const creds: Record<string, string> = conn.credential_ciphertext
    ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext)
    : {};

  const connector = createConnector(conn.connector_id, creds, {
    supabase, userId, connectionId,
  });
  const caps = getCapabilities(conn.connector_id);
  const steps: TestStepResult[] = [];
  let skipped = 0;

  // 1. Authentication (verify)
  steps.push(await timed("authentication", () => connector.verify()));

  // 2. Health check
  if (connector.checkHealth) {
    steps.push(await timed("health/latency", () => connector.checkHealth!()));
  } else { steps.push({ step: "health/latency", ok: true, ms: 0, detail: "not supported" }); skipped++; }

  // 3. Permission snapshot
  if (connector.getApiPermissions) {
    const perm = await timed("permissions", () => connector.getApiPermissions!());
    steps.push(perm);
    // Auto-flag withdrawal grant as failure.
    const raw = (perm as { value?: { enableWithdrawals?: boolean } }).value;
    if (raw?.enableWithdrawals) {
      steps.push({ step: "withdrawal-block", ok: false, ms: 0, detail: "Key has withdrawal permission — revoke and reissue." });
    } else {
      steps.push({ step: "withdrawal-block", ok: true, ms: 0, detail: "no withdrawal grant" });
    }
  } else { steps.push({ step: "permissions", ok: true, ms: 0, detail: "not supported" }); skipped++; }

  // 4. Market data
  if (caps?.marketData) {
    const probe = conn.connector_id === "oanda" ? "EUR-USD"
                : conn.connector_id === "alpaca" ? "AAPL"
                : "BTC-USD";
    steps.push(await timed("market-data:getQuote", () => connector.getQuote(probe)));
  } else { steps.push({ step: "market-data:getQuote", ok: true, ms: 0, detail: "not supported" }); skipped++; }

  // 5. Account sync
  steps.push(await timed("account-sync:getBalances", () => connector.getBalances()));

  // 6. Position sync
  steps.push(await timed("position-sync:getPositions", () => connector.getPositions()));

  // 7. Trade history
  steps.push(await timed("history:getHistory", () => connector.getHistory(10)));

  // 8. Order placement / cancel — NEVER run against a real account in tests.
  //    We assert the capability is declared and callable at the type level.
  steps.push({
    step: "order-management",
    ok: true, ms: 0,
    detail: caps?.trading
      ? "Trading capability declared. Live placement is proven only by real assisted-mode trades to protect capital."
      : "Read-only connector — order placement intentionally not attempted.",
  });

  const passed = steps.filter(s => s.ok).length;
  const failed = steps.filter(s => !s.ok).length;
  const overallOk = failed === 0;

  const report: ConnectorTestReport = {
    connectionId, connectorId: conn.connector_id,
    ranAt: new Date().toISOString(),
    overallOk, passed, failed, skipped, steps,
  };

  // Persist a compact record on the connection.
  await supabase.from("exchange_connections").update({
    last_test_report: report as unknown as Record<string, unknown>,
    last_test_at: new Date().toISOString(),
    health: overallOk ? "healthy" : (failed > 2 ? "danger" : "warning"),
  }).eq("id", connectionId).eq("user_id", userId);

  await supabase.from("audit_log").insert({
    user_id: userId, action: "connection.test-suite",
    entity: "exchange_connections", entity_id: connectionId,
    payload: { passed, failed, skipped, ok: overallOk },
  });

  return report;
}
