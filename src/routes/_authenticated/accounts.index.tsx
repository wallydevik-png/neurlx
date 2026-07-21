import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import {
  disconnectConnection, listConnections, setPermissions,
  scanConnectionHealth, runConnectorTests,
  enableFullAutopilot, disableFullAutopilot,
  updateTradingLimits, getSettings,
} from "@/lib/trading.functions";
import { getBroker } from "@/lib/connectors/brokerRegistry";
import { capabilityBadges, getCapabilities } from "@/lib/connectors/capabilities";
import { Plus, Trash2, Shield, ShieldCheck, Activity, AlertTriangle, TestTube2, CheckCircle2, XCircle, Sparkles, Sliders } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/accounts/")({
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

  const autopilotOnFn = useServerFn(enableFullAutopilot);
  const autopilotOffFn = useServerFn(disableFullAutopilot);

  async function togglePerm(id: string, enabled: boolean) {
    try {
      await permFn({ data: { id, tradingEnabled: enabled } });
      toast.success(enabled ? "Trading permission enabled" : "Trading permission revoked");
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function toggleAutopilot(id: string, turnOn: boolean) {
    try {
      if (turnOn) {
        if (!confirm("Turn on Full Autopilot?\n\nThe AI will scan markets, generate signals, run risk checks, and place LIVE orders on this account 24/7 until you turn it off. Withdrawals stay disabled — profits remain in your exchange account.")) return;
        await autopilotOnFn({ data: { connectionId: id } });
        toast.success("Autopilot ON — the AI is now trading this account.");
      } else {
        await autopilotOffFn();
        toast.success("Autopilot OFF");
      }
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

      <TradingLimitsPanel />


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
                      <span className={`text-[10px] font-mono uppercase font-bold rounded px-2 py-0.5 ${
                        c.trading_enabled && c.status === "connected" && c.connector_id !== "paper"
                          ? "bg-destructive text-destructive-foreground"
                          : c.connector_id === "paper"
                          ? "bg-primary/20 text-primary border border-primary/40"
                          : "bg-warning/15 text-warning border border-warning/40"
                      }`}>
                        {c.trading_enabled && c.status === "connected" && c.connector_id !== "paper"
                          ? "● LIVE — real money"
                          : c.connector_id === "paper" ? "Demo · paper"
                          : "Read-only"}
                      </span>
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

                {c.connector_id !== "paper" && c.status === "connected" && (
                  <div className={`mt-4 pt-4 border-t border-border`}>
                    <div className={`rounded-lg border p-4 ${c.autopilot_on ? "border-primary/50 bg-primary/5" : "border-border bg-secondary/30"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex gap-2.5 min-w-0">
                          <Sparkles className={`w-5 h-5 mt-0.5 shrink-0 ${c.autopilot_on ? "text-primary" : "text-muted-foreground"}`} />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold flex items-center gap-2">
                              Full Autopilot
                              {c.autopilot_on && (
                                <span className="text-[10px] font-mono uppercase rounded px-1.5 py-0.5 bg-primary/20 text-primary border border-primary/40">
                                  ● ON
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              Let the AI do everything — scan markets, backtest, generate signals, size positions, place live orders, and manage SL/TP automatically. You just log in to see your trade history and P&L. Withdrawals stay OFF for your safety.
                            </p>
                          </div>
                        </div>
                        <button
                          disabled={!c.trading_enabled}
                          onClick={() => toggleAutopilot(c.id, !c.autopilot_on)}
                          title={!c.trading_enabled ? "Enable Trading permission first" : ""}
                          className={`w-12 h-7 rounded-full transition relative shrink-0 ${
                            c.autopilot_on ? "bg-primary" : "bg-muted"
                          } ${!c.trading_enabled ? "opacity-40 cursor-not-allowed" : ""}`}
                        >
                          <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-background transition ${c.autopilot_on ? "left-[22px]" : "left-0.5"}`} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}

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

function TradingLimitsPanel() {
  const getFn = useServerFn(getSettings);
  const saveFn = useServerFn(updateTradingLimits);
  const qc = useQueryClient();
  const { data: s } = useQuery({ queryKey: ["settings"], queryFn: () => getFn() });
  const [form, setForm] = useState<{ trades: string; size: string; live: string; open: string } | null>(null);
  const current = form ?? (s ? {
    trades: String(s.max_trades_per_day),
    size: String(s.max_trade_size),
    live: String(s.live_max_notional_per_order),
    open: String(s.autonomous_max_open_positions),
  } : null);
  if (!current) return null;
  async function save() {
    try {
      await saveFn({ data: {
        max_trades_per_day: Number(current!.trades),
        max_trade_size: Number(current!.size),
        live_max_notional_per_order: Number(current!.live),
        autonomous_max_open_positions: Number(current!.open),
      }});
      toast.success("Trading limits saved");
      setForm(null);
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  const dirty = form !== null;
  return (
    <div className="panel p-5 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Sliders className="w-4 h-4 text-primary" />
        <h2 className="font-semibold text-sm">Trading limits</h2>
        <span className="text-xs text-muted-foreground">Applies to every connected account · Autopilot obeys these caps</span>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <LimitField label="Max trades / day" hint="Hard cap across all accounts" value={current.trades} onChange={v => setForm({ ...current, trades: v })} suffix="trades" />
        <LimitField label="Max size / trade (paper)" hint="Notional cap for demo orders" value={current.size} onChange={v => setForm({ ...current, size: v })} suffix="USD" />
        <LimitField label="Max size / trade (live)" hint="Notional cap for real orders" value={current.live} onChange={v => setForm({ ...current, live: v })} suffix="USD" />
        <LimitField label="Max open positions" hint="Concurrent positions cap" value={current.open} onChange={v => setForm({ ...current, open: v })} suffix="pos" />
      </div>
      {dirty && (
        <div className="mt-3 flex gap-2 justify-end">
          <button onClick={() => setForm(null)} className="text-xs px-3 py-1.5 rounded-md border border-border">Cancel</button>
          <button onClick={save} className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium">Save limits</button>
        </div>
      )}
    </div>
  );
}

function LimitField({ label, hint, value, onChange, suffix }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; suffix: string;
}) {
  return (
    <div>
      <label className="block text-[10px] font-mono uppercase text-muted-foreground">{label}</label>
      <div className="mt-1 flex items-center gap-1.5 rounded-md border border-border bg-background px-2">
        <input type="number" min={0} step="any" value={value} onChange={e => onChange(e.target.value)}
          className="flex-1 bg-transparent py-1.5 text-sm font-mono outline-none" />
        <span className="text-[10px] font-mono text-muted-foreground">{suffix}</span>
      </div>
      <div className="text-[10px] text-muted-foreground mt-1">{hint}</div>
    </div>
  );
}
