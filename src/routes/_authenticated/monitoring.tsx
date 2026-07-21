import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd } from "@/components/AppShell";
import { getLiveMonitoring, getExecutionHealth } from "@/lib/monitoring.functions";
import { reconcileNow } from "@/lib/assistedLive.functions";
import { toast } from "sonner";
import { Radar, Plug, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/monitoring")({
  head: () => ({ meta: [{ title: "Live Monitoring — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Monitoring,
});

function Monitoring() {
  const fn = useServerFn(getLiveMonitoring);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["monitoring"], queryFn: () => fn(), refetchInterval: 30000,
  });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading…</div></AppShell>;

  return (
    <AppShell>
      <PageHeader
        title="Live Monitoring"
        subtitle="Real-time view of every connected account. Read-only — no orders are ever placed."
        action={
          <button onClick={() => refetch()} disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase disabled:opacity-60">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Sync
          </button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Connections" value={String(data.connections.length)}
          sub={`${data.connections.filter(c => c.synced).length} synced`} />
        <Metric label="Paper cash" value={fmtUsd(data.paperAccount.cashBalance)} />
        <Metric label="Open positions" value={String(data.paperAccount.openPositions)} />
        <Metric label="Market exposure" value={fmtUsd(data.paperAccount.marketExposure)}
          sub={`${(data.paperAccount.exposurePctOfEquity * 100).toFixed(1)}% of equity`} />
      </div>

      <div className="panel p-4 sm:p-6 mt-4">
        <div className="flex items-center gap-2">
          <Radar className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Connected accounts</h2>
        </div>
        {data.connections.length === 0 ? (
          <div className="mt-4 text-sm text-muted-foreground">
            No accounts connected. <Link to="/accounts/new" className="text-primary hover:underline">Add one</Link> — Binance is available in read-only mode.
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {data.connections.map(c => (
              <div key={c.id} className="rounded-md border border-border p-4">
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-start sm:flex sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Plug className="w-4 h-4 shrink-0 text-primary" />
                      <span className="font-semibold truncate">{c.label}</span>
                      <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1.5 py-0.5">
                        {c.connectorId}
                      </span>
                      {c.health === "healthy" ? (
                        <span className="text-[10px] font-mono uppercase text-success inline-flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> healthy
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono uppercase text-warning inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> {c.health}
                        </span>
                      )}
                      <span className="text-[10px] font-mono uppercase text-muted-foreground">
                        {c.tradingEnabled ? "trade" : "read-only"}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground font-mono">
                      Last sync: {c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString() : "never"}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[10px] font-mono uppercase text-muted-foreground">Cash</div>
                    <div className="font-mono">{fmtUsd(c.cashUsd)}</div>
                  </div>
                </div>

                {c.liveError && (
                  <div className="mt-3 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded p-2">
                    {c.liveError}
                  </div>
                )}

                {c.balances.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Balances</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-xs">
                      {c.balances.slice(0, 12).map(b => (
                        <div key={b.currency} className="flex justify-between border-b border-border/50 py-1">
                          <span className="font-mono text-muted-foreground">{b.currency}</span>
                          <span className="font-mono">{b.total.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {c.positions.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[10px] font-mono uppercase text-muted-foreground mb-1">Positions (spot balances)</div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-xs">
                      {c.positions.slice(0, 12).map(p => (
                        <div key={p.symbol} className="flex justify-between border-b border-border/50 py-1">
                          <span className="font-mono text-muted-foreground">{p.symbol}</span>
                          <span className="font-mono">{p.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <ExecutionHealthPanel />

      <div className="text-[11px] text-muted-foreground mt-4 font-mono">
        Generated {new Date(data.generatedAt).toLocaleTimeString()} · Live execution routes only when explicitly enabled per approval.
      </div>
    </AppShell>
  );
}

function ExecutionHealthPanel() {
  const fn = useServerFn(getExecutionHealth);
  const rec = useServerFn(reconcileNow);
  const { data, refetch } = useQuery({
    queryKey: ["exec-health"], queryFn: () => fn(), refetchInterval: 30000,
  });
  if (!data) return null;
  const pctErr = (data.api.errorRate * 100).toFixed(1);
  const pctFill = (data.orders.fillRate * 100).toFixed(0);
  async function onReconcile(id: string) {
    try { const r = await rec({ data: { connectionId: id } });
      toast.success(`Reconciled ${r.updated} of ${r.scanned} orders`); refetch();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  return (
    <div className="panel p-4 sm:p-6 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-warning" />
        <h2 className="font-semibold">Execution health · last 24h</h2>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="API calls" value={String(data.api.total)} sub={`${pctErr}% errors`} />
        <Metric label="API p95 latency" value={`${data.api.p95Ms} ms`} sub={`p50 ${data.api.p50Ms} ms`} />
        <Metric label="Orders (live/total)" value={`${data.orders.live}/${data.orders.total}`} sub={`${pctFill}% fill rate`} />
        <Metric label="Slippage p95" value={`${data.orders.slippageP95Bps.toFixed(1)} bps`} sub={`exec p95 ${data.orders.execP95Ms} ms`} />
      </div>
      {data.connections.length > 0 && (
        <div className="mt-4 space-y-2">
          {data.connections.map(c => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs font-mono border border-border rounded-md p-2">
              <span className="font-semibold">{c.connectorId.toUpperCase()}</span>
              <span className="text-muted-foreground truncate">{c.label}</span>
              <span className={c.health === "healthy" ? "text-success" : c.health === "degraded" ? "text-warning" : "text-destructive"}>
                {c.health ?? "unknown"}
              </span>
              {c.clockSkewMs !== null && <span className="text-muted-foreground">skew {c.clockSkewMs}ms</span>}
              {c.tradingEnabled && <span className="text-warning">LIVE ENABLED</span>}
              <button onClick={() => onReconcile(c.id)}
                className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-secondary">
                <RefreshCw className="w-3 h-3" /> Reconcile
              </button>
            </div>
          ))}
        </div>
      )}
      {data.recentIncidents.length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase font-mono text-muted-foreground mb-1">Recent incidents</div>
          {data.recentIncidents.slice(0, 5).map((i, k) => (
            <div key={k} className="text-xs font-mono flex gap-2">
              <span className={i.severity === "critical" || i.severity === "error" ? "text-destructive" : "text-warning"}>
                {i.severity}
              </span>
              <span className="text-muted-foreground">{i.event}</span>
              <span className="truncate">{i.message}</span>
            </div>
          ))}
        </div>
      )}
      {data.api.total === 0 && (
        <div className="mt-3 text-xs text-muted-foreground">No exchange API traffic yet. Once live trading is enabled, health metrics appear here.</div>
      )}
      <div className="mt-3 flex justify-end">
        <button onClick={() => refetch()} className="text-[10px] uppercase font-mono text-primary hover:underline">
          <CheckCircle2 className="w-3 h-3 inline mr-1" /> Refresh
        </button>
      </div>
    </div>
  );
}
