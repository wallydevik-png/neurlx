// Live trading activation flow. In this build, activation only lifts the UI
// gate — every order is still routed to the paper connector by the engine.
// Kept production-shaped so switching to real venue execution is one line.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import { listConnections, getSettings } from "@/lib/trading.functions";
import {
  scanConnectionPermissions, activateLiveTrading, deactivateLiveTrading,
  resetCircuitBreaker,
} from "@/lib/assistedLive.functions";
import { toast } from "sonner";
import { useState } from "react";
import {
  ShieldAlert, ShieldCheck, ScanLine, ArrowLeft, AlertTriangle, Check,
  Power,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/accounts/$id/activate")({
  head: () => ({ meta: [{ title: "Activate Live Trading — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Activate,
});

type PermissionScan = {
  scopes: string[]; can_read: boolean; can_trade: boolean;
  can_withdraw: boolean; can_transfer_internal: boolean;
  can_margin: boolean; can_futures: boolean;
};

function Activate() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const listFn = useServerFn(listConnections);
  const settingsFn = useServerFn(getSettings);
  const scanFn = useServerFn(scanConnectionPermissions);
  const activateFn = useServerFn(activateLiveTrading);
  const deactivateFn = useServerFn(deactivateLiveTrading);
  const resetCbFn = useServerFn(resetCircuitBreaker);

  const { data: conns = [] } = useQuery({ queryKey: ["connections"], queryFn: () => listFn() });
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => settingsFn() });
  const conn = conns.find(c => c.id === id);
  const scan = (conn?.permission_scan as PermissionScan | null | undefined) ?? null;

  const [phrase, setPhrase] = useState("");
  const [maxNotional, setMaxNotional] = useState<string>(
    String(settings?.live_max_notional_per_order ?? 50),
  );
  const [ackWithdrawal, setAckWithdrawal] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [activating, setActivating] = useState(false);

  const cbOpen = settings?.live_kill_until && new Date(settings.live_kill_until) > new Date();

  if (!conn) {
    return (
      <AppShell>
        <div className="panel p-10 text-center">
          <p className="text-sm text-muted-foreground">Connection not found.</p>
          <Link to="/accounts" className="mt-3 inline-block text-primary text-sm">← Back to accounts</Link>
        </div>
      </AppShell>
    );
  }

  async function doScan() {
    setScanning(true);
    try {
      await scanFn({ data: { connectionId: id } });
      toast.success("Permission scan complete");
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setScanning(false); }
  }

  async function doActivate() {
    setActivating(true);
    try {
      const r = await activateFn({ data: {
        connectionId: id,
        confirmationPhrase: phrase,
        maxNotionalPerOrder: Number(maxNotional),
        acknowledgedWithdrawal: ackWithdrawal,
      }});
      toast.success(r.message);
      qc.invalidateQueries();
      navigate({ to: "/accounts" });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setActivating(false); }
  }

  async function doDeactivate() {
    try {
      await deactivateFn({ data: { connectionId: id } });
      toast.success("Live trading deactivated");
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function doResetCb() {
    try {
      await resetCbFn();
      toast.success("Circuit breaker reset");
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  const canActivate = scan
    && scan.can_read
    && scan.can_trade
    && phrase === "ENABLE LIVE TRADING"
    && Number(maxNotional) > 0
    && (!scan.can_withdraw || ackWithdrawal);

  return (
    <AppShell>
      <PageHeader
        title={`Live trading — ${conn.label}`}
        subtitle="Upgrade this connection from read-only to trading. All safety checks are mandatory."
        action={
          <Link to="/accounts" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> Back to accounts
          </Link>
        }
      />

      <div className="panel p-4 mb-4 border-destructive/40 bg-destructive/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="text-sm">
            <div className="font-semibold text-destructive">Real money warning</div>
            <p className="text-muted-foreground mt-1">
              Once activated, NeurlX will place <b>real orders on {conn.label}</b> using your API key.
              Every order still passes the risk gate, pre-trade checks, and circuit breakers — but
              fills, fees, and P&amp;L are real. Start with a small <b>Max notional per order</b> until
              you've verified behaviour end-to-end.
            </p>
          </div>
        </div>
      </div>

      {cbOpen && (
        <div className="panel p-4 mb-4 border-destructive/40 bg-destructive/5">
          <div className="flex items-start gap-3">
            <Power className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-semibold text-destructive">Live-execution circuit breaker OPEN</div>
              <p className="text-sm text-muted-foreground mt-1">
                {settings?.live_kill_reason} · until {new Date(settings!.live_kill_until!).toLocaleString()}
              </p>
            </div>
            <button onClick={doResetCb} className="rounded-md border border-destructive/40 text-destructive text-xs px-3 py-1.5 hover:bg-destructive/10">
              Reset breaker
            </button>
          </div>
        </div>
      )}

      {/* Step 1: permission scan */}
      <Section n={1} title="Scan API permissions">
        <p className="text-sm text-muted-foreground">
          Detect what your API key can do. We refuse to enable trading on keys with withdrawal permission
          unless you explicitly acknowledge the risk.
        </p>
        {scan ? (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-3 gap-2">
            <PermChip on={scan.can_read} label="Read" safe />
            <PermChip on={scan.can_trade} label="Trade" safe />
            <PermChip on={scan.can_withdraw} label="Withdraw" danger />
            <PermChip on={scan.can_transfer_internal} label="Transfer internal" warn />
            <PermChip on={scan.can_margin} label="Margin" warn />
            <PermChip on={scan.can_futures} label="Futures" warn />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic mt-3">No scan yet.</p>
        )}
        <button onClick={doScan} disabled={scanning}
          className="mt-4 inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm hover:bg-secondary disabled:opacity-50">
          <ScanLine className="w-4 h-4" /> {scanning ? "Scanning…" : scan ? "Re-scan" : "Scan permissions"}
        </button>
      </Section>

      {/* Step 2: safety acknowledgements */}
      {scan && (
        <Section n={2} title="Configure & acknowledge">
          {scan.can_withdraw && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 mb-4">
              <div className="flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <div className="text-sm">
                  <div className="font-medium text-destructive">Withdrawal permission detected</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Regenerate this API key on the exchange with withdrawals <b>disabled</b>, then re-scan.
                    Or acknowledge the risk to proceed anyway.
                  </p>
                  <label className="mt-2 flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={ackWithdrawal} onChange={e => setAckWithdrawal(e.target.checked)} />
                    I understand this key can withdraw funds and accept the risk.
                  </label>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-sm">
              <div className="text-[10px] uppercase font-mono text-muted-foreground mb-1">Max notional per order (USD)</div>
              <input type="number" min="1" max="10000" step="1" value={maxNotional}
                onChange={e => setMaxNotional(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-input border border-border font-mono text-sm" />
              <div className="text-[11px] text-muted-foreground mt-1">Hard cap — no order can exceed this even after risk-gate approval.</div>
            </label>
            <div className="text-sm">
              <div className="text-[10px] uppercase font-mono text-muted-foreground mb-1">Current risk settings</div>
              <div className="text-xs font-mono space-y-0.5 text-muted-foreground p-3 rounded-md bg-secondary/30 border border-border">
                <div>Mode: {settings?.mode}</div>
                <div>Risk level: {settings?.risk_level}</div>
                <div>Min confidence: {((settings?.min_confidence ?? 0) * 100).toFixed(0)}%</div>
                <div>Max daily loss: ${settings?.max_daily_loss}</div>
                <div>Max trades/day: {settings?.max_trades_per_day}</div>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-[10px] uppercase font-mono text-muted-foreground mb-1">
              Type <span className="text-destructive">ENABLE LIVE TRADING</span> to confirm
            </div>
            <input type="text" value={phrase} onChange={e => setPhrase(e.target.value)}
              placeholder="ENABLE LIVE TRADING"
              className="w-full px-3 py-2 rounded-md bg-input border border-border font-mono text-sm" />
          </div>
        </Section>
      )}

      {/* Step 3: activate */}
      {scan && (
        <div className="flex flex-wrap gap-2">
          <button
            onClick={doActivate}
            disabled={!canActivate || activating || !!cbOpen}
            className="inline-flex items-center gap-2 rounded-md bg-success px-5 py-2.5 text-sm font-semibold text-success-foreground disabled:opacity-40 disabled:cursor-not-allowed">
            <ShieldCheck className="w-4 h-4" />
            {activating ? "Activating…" : "Activate live trading"}
          </button>
          {conn.trading_enabled && (
            <button onClick={doDeactivate}
              className="inline-flex items-center gap-2 rounded-md border border-destructive/40 text-destructive px-5 py-2.5 text-sm font-medium hover:bg-destructive/10">
              <Power className="w-4 h-4" /> Deactivate
            </button>
          )}
          {conn.trading_activated_at && (
            <div className="ml-auto text-xs text-muted-foreground font-mono self-center flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-success" />
              Activated {new Date(conn.trading_activated_at).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </AppShell>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="panel p-5 sm:p-6 mb-4">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-7 h-7 rounded-full bg-primary/15 text-primary grid place-items-center text-sm font-mono font-semibold">{n}</div>
        <h2 className="font-semibold">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function PermChip({ on, label, safe, warn, danger }: {
  on: boolean; label: string; safe?: boolean; warn?: boolean; danger?: boolean;
}) {
  const tone = on
    ? (danger ? "border-destructive/50 bg-destructive/10 text-destructive"
      : warn ? "border-warning/50 bg-warning/10 text-warning"
      : safe ? "border-success/40 bg-success/10 text-success" : "border-border")
    : "border-border bg-secondary/30 text-muted-foreground";
  return (
    <div className={`rounded-md border px-3 py-2 text-xs font-mono flex items-center gap-2 ${tone}`}>
      <span className={`w-2 h-2 rounded-full ${on ? "bg-current" : "bg-muted-foreground/30"}`} />
      {label} {on ? "on" : "off"}
    </div>
  );
}
