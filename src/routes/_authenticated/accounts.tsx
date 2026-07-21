import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import {
  disconnectConnection, listConnections, setPermissions,
  scanConnectionHealth, runConnectorTests,
} from "@/lib/trading.functions";
import { getBroker } from "@/lib/connectors/brokerRegistry";
import { capabilityBadges, getCapabilities } from "@/lib/connectors/capabilities";
import { Plus, Trash2, Shield, ShieldCheck, Activity, AlertTriangle, TestTube2, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/accounts")({
  head: () => ({ meta: [{ title: "Connected Accounts — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Accounts,
});

function Accounts() {
  const fetchFn = useServerFn(listConnections);
  const disconnectFn = useServerFn(disconnectConnection);
  const permFn = useServerFn(setPermissions);
  const qc = useQueryClient();

  const { data: conns = [], isLoading } = useQuery({
    queryKey: ["connections"], queryFn: () => fetchFn(),
  });

  async function togglePerm(id: string, enabled: boolean) {
    try {
      await permFn({ data: { id, tradingEnabled: enabled } });
      toast.success(enabled ? "Trading permission enabled" : "Trading permission revoked");
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function disconnect(id: string) {
    if (!confirm("Disconnect this account? Credentials will be permanently wiped.")) return;
    try {
      await disconnectFn({ data: { id } });
      toast.success("Disconnected");
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader
        title="Connected Accounts"
        subtitle="Add trading platforms, manage permissions, and monitor connection health."
        action={
          <Link to="/accounts/new" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            <Plus className="w-4 h-4" /> Add trading platform
          </Link>
        }
      />

      {isLoading ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : conns.length === 0 ? (
        <div className="panel p-10 text-center">
          <Shield className="w-8 h-8 text-primary mx-auto" />
          <h2 className="mt-4 font-semibold">No accounts connected</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Start with a paper trading account. Add real exchanges later — they inherit the same modular connector interface.
          </p>
          <Link to="/accounts/new" className="mt-5 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            <Plus className="w-4 h-4" /> Add first account
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {conns.map(c => {
            const desc = getBroker(c.connector_id);
            const caps = getCapabilities(c.connector_id);
            const badges = capabilityBadges(c.connector_id);
            const errs = Array.isArray(c.error_history) ? c.error_history : [];
            const livePerms = (c.permissions_snapshot as { live?: Record<string, boolean> } | null)?.live;
            const report = c.last_test_report as {
              overallOk: boolean; passed: number; failed: number; skipped: number;
              steps: Array<{ step: string; ok: boolean; ms: number; detail?: string }>;
            } | null;
            return (
              <div key={c.id} className="panel p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold">{c.label}</h3>
                      <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1.5 py-0.5">
                        {desc?.displayName ?? c.connector_id}
                      </span>
                      {c.auth_method && (
                        <span className="text-[10px] font-mono uppercase text-primary border border-primary/40 rounded px-1.5 py-0.5">
                          {c.auth_method.replace("_", " ")}
                        </span>
                      )}
                      <span className={`text-[10px] font-mono uppercase rounded px-1.5 py-0.5 ${
                        c.status === "connected" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                      }`}>{c.status}</span>
                      <span className={`text-[10px] font-mono uppercase rounded px-1.5 py-0.5 ${
                        c.health === "healthy" ? "bg-success/15 text-success"
                        : c.health === "warning" ? "bg-warning/15 text-warning"
                        : c.health === "danger" ? "bg-destructive/15 text-destructive"
                        : "bg-muted text-muted-foreground"
                      }`}>{c.health}</span>
                      {caps && !caps.implemented && (
                        <span className="text-[10px] font-mono uppercase rounded px-1.5 py-0.5 border border-warning/40 text-warning">
                          framework-ready
                        </span>
                      )}
                    </div>
                    {caps && (
                      <div className="mt-2 text-xs text-muted-foreground">{caps.summary}</div>
                    )}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {badges.map(b => (
                        <span key={b.label} className={`text-[9px] font-mono uppercase rounded px-1.5 py-0.5 border ${
                          b.tone === "on" ? "border-success/40 text-success"
                          : b.tone === "off" ? "border-border text-muted-foreground opacity-60"
                          : "border-primary/40 text-primary"
                        }`}>{b.label}</span>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground font-mono">
                      Last sync: {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : "never"}
                      {typeof c.latency_ms === "number" && <> · Latency: {c.latency_ms}ms</>}
                      {c.broker_server && <> · Server: {c.broker_server}</>}
                      {c.account_number && <> · Acct: {c.account_number}</>}
                    </div>
                    {livePerms && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Object.entries(livePerms).map(([k, v]) => (
                          <span key={k} className={`text-[10px] font-mono uppercase rounded px-1.5 py-0.5 border ${
                            v ? (k === "withdrawals" ? "text-destructive border-destructive/40" : "text-success border-success/40")
                              : "text-muted-foreground border-border"
                          }`}>
                            {k}: {v ? "on" : "off"}
                          </span>
                        ))}
                      </div>
                    )}
                    {errs.length > 0 && (
                      <div className="mt-2 flex items-start gap-1.5 text-xs text-warning">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>Last error: {(errs[0] as { message?: string })?.message ?? "unknown"}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <ScanButton id={c.id} />
                    <TestButton id={c.id} />
                    <Link to="/accounts/$id/activate" params={{ id: c.id }}
                      className="text-xs px-3 py-1.5 rounded-md border border-primary/40 text-primary hover:bg-primary/10 font-medium whitespace-nowrap">
                      Manage live trading
                    </Link>
                    <button onClick={() => disconnect(c.id)}
                      className="p-2 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {report && (
                  <div className="mt-4 pt-4 border-t border-border">
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`font-mono uppercase rounded px-1.5 py-0.5 ${
                        report.overallOk ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                      }`}>
                        Test suite {report.overallOk ? "PASSED" : "FAILED"}
                      </span>
                      <span className="text-muted-foreground">
                        {report.passed} passed · {report.failed} failed · {report.skipped} skipped
                      </span>
                    </div>
                    <div className="mt-2 grid sm:grid-cols-2 gap-1">
                      {report.steps.map(s => (
                        <div key={s.step} className="flex items-start gap-1.5 text-[11px]">
                          {s.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-success mt-0.5" />
                                : <XCircle className="w-3.5 h-3.5 text-destructive mt-0.5" />}
                          <div className="min-w-0">
                            <div className="font-mono text-muted-foreground">{s.step} · {s.ms}ms</div>
                            {s.detail && <div className="text-muted-foreground/70 truncate">{s.detail}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 grid md:grid-cols-2 gap-3 pt-4 border-t border-border">
                  <PermRow
                    label="Read access"
                    desc="View balances, market data, positions, and history."
                    on={c.read_enabled}
                    disabled
                    icon={<Shield className="w-4 h-4" />}
                  />
                  <PermRow
                    label="Trading permission"
                    desc="Allow AI or manual orders to be placed on this account."
                    on={c.trading_enabled}
                    icon={<ShieldCheck className="w-4 h-4" />}
                    onToggle={(v) => togglePerm(c.id, v)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}

function PermRow({ label, desc, on, disabled, icon, onToggle }: {
  label: string; desc: string; on: boolean; disabled?: boolean; icon: React.ReactNode;
  onToggle?: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-border bg-secondary/30">
      <div className="flex gap-2">
        <div className="text-primary mt-0.5">{icon}</div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
      <button
        disabled={disabled}
        onClick={() => onToggle?.(!on)}
        className={`w-10 h-6 rounded-full transition relative shrink-0 ${
          on ? "bg-primary" : "bg-muted"
        } ${disabled ? "opacity-50" : ""}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-background transition ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}

function ScanButton({ id }: { id: string }) {
  const scanFn = useServerFn(scanConnectionHealth);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await scanFn({ data: { id } });
      toast[r.ok ? "success" : "error"](
        r.ok ? `Healthy · ${r.latencyMs}ms` : (r.message || "Health check failed"),
      );
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally { setBusy(false); }
  }
  return (
    <button onClick={run} disabled={busy}
      title="Run health & permission scan"
      className="p-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/40 disabled:opacity-50">
      <Activity className={`w-4 h-4 ${busy ? "animate-pulse" : ""}`} />
    </button>
  );
}

function TestButton({ id }: { id: string }) {
  const testFn = useServerFn(runConnectorTests);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const r = await testFn({ data: { id } });
      toast[r.overallOk ? "success" : "error"](
        `Test suite ${r.overallOk ? "passed" : "failed"} · ${r.passed}/${r.passed + r.failed} checks`,
      );
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Test suite failed");
    } finally { setBusy(false); }
  }
  return (
    <button onClick={run} disabled={busy}
      title="Run the connector test suite (auth, market data, sync, permissions)"
      className="p-2 rounded-md border border-border text-muted-foreground hover:text-primary hover:border-primary/40 disabled:opacity-50">
      <TestTube2 className={`w-4 h-4 ${busy ? "animate-pulse" : ""}`} />
    </button>
  );
}
