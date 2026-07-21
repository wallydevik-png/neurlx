import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import { getPerformanceOverview } from "@/lib/assistedLive.functions";

export const Route = createFileRoute("/_authenticated/performance")({
  head: () => ({ meta: [{ title: "Performance — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: PerformancePage,
});

function PerformancePage() {
  const fetchFn = useServerFn(getPerformanceOverview);
  const { data } = useQuery({ queryKey: ["performance"], queryFn: () => fetchFn(), refetchInterval: 20000 });

  if (!data) return <AppShell><div className="panel p-10 text-center text-sm text-muted-foreground">Loading…</div></AppShell>;

  const pf = data.profitFactor;
  return (
    <AppShell>
      <PageHeader
        title="Performance Dashboard"
        subtitle="Account growth, risk-adjusted return, AI win rate, and execution quality."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Metric label="Account value" value={fmtUsd(data.accountValue)} />
        <Metric label="Realized P&L" value={fmtUsd(data.totalRealized)}
          tone={data.totalRealized >= 0 ? "pos" : "neg"} />
        <Metric label="Win rate" value={fmtPct(data.winRate)}
          sub={`${data.totalClosed} closed`} />
        <Metric label="Profit factor" value={pf != null ? pf.toFixed(2) + "×" : "—"} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Metric label="Avg win" value={fmtUsd(data.avgWin)} tone="pos" />
        <Metric label="Avg loss" value={fmtUsd(data.avgLoss)} tone="neg" />
        <Metric label="Avg hold" value={formatDur(data.avgDurationSec)} />
        <Metric label="Exec quality" value={data.avgQuality.toFixed(1) + "/10"} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        <Metric label="Signals generated" value={String(data.totalSignals)} />
        <Metric label="User approval rate" value={fmtPct(data.approvalRate)}
          sub="approved / decided" />
        <Metric label="Order retries · errors" value={`${data.orderRetries} · ${data.orderErrors}`} />
      </div>

      <div className="panel p-5 sm:p-6">
        <div className="text-[10px] uppercase font-mono text-muted-foreground mb-3">Monthly P&L</div>
        {data.monthly.length === 0 ? (
          <div className="text-sm text-muted-foreground">No completed trades yet.</div>
        ) : (
          <div className="space-y-2">
            {data.monthly.map(m => {
              const max = Math.max(...data.monthly.map(x => Math.abs(x.pnl)), 1);
              const w = (Math.abs(m.pnl) / max) * 100;
              return (
                <div key={m.month} className="flex items-center gap-3 text-xs font-mono">
                  <div className="w-16 text-muted-foreground">{m.month}</div>
                  <div className="flex-1 h-6 bg-secondary/30 rounded relative">
                    <div className={`absolute inset-y-0 left-0 rounded ${m.pnl >= 0 ? "bg-success/60" : "bg-destructive/60"}`}
                      style={{ width: `${w}%` }} />
                  </div>
                  <div className={`w-20 text-right ${m.pnl >= 0 ? "text-success" : "text-destructive"}`}>
                    {fmtUsd(m.pnl)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function formatDur(s: number): string {
  if (!s) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
