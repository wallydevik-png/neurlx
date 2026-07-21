import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtPct } from "@/components/AppShell";
import { getSignalAccuracy } from "@/lib/backtest.functions";

export const Route = createFileRoute("/_authenticated/accuracy")({
  head: () => ({ meta: [{ title: "AI Accuracy — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Accuracy,
});

function Accuracy() {
  const fn = useServerFn(getSignalAccuracy);
  const { data } = useQuery({ queryKey: ["signal-accuracy"], queryFn: () => fn(), refetchInterval: 30000 });
  const groups = data ?? { total: 0, byConfidence: [], byRegime: [], bySymbol: [], byHorizon: [] };

  const overall = groups.byConfidence.reduce((s, g) => ({ wins: s.wins + g.wins, total: s.total + g.total }), { wins: 0, total: 0 });
  const overallWin = overall.total ? overall.wins / overall.total : 0;

  return (
    <AppShell>
      <PageHeader title="AI Signal Accuracy" subtitle="Confidence calibration and outcome breakdowns across every evaluated signal. Past performance does not guarantee future results." />

      {groups.total === 0 ? (
        <div className="panel p-8 text-center text-sm text-muted-foreground">
          No evaluated signals yet. Generate signals from the AI Signals page and outcomes will appear here as they resolve.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Metric label="Evaluated signals" value={groups.total.toString()} />
            <Metric label="Overall win rate" value={fmtPct(overallWin)} tone={overallWin >= 0.5 ? "pos" : "neg"} />
            <Metric label="Avg P&L per signal" value={fmtPct(
              groups.byConfidence.reduce((s, g) => s + g.avgPnlPct * g.total, 0) / (groups.total || 1)
            )} />
          </div>

          <Panel title="Accuracy by confidence level" rows={groups.byConfidence} keyLabel="Confidence" />
          <Panel title="Accuracy by market regime" rows={groups.byRegime} keyLabel="Regime" />
          <Panel title="Accuracy by asset" rows={groups.bySymbol} keyLabel="Asset" />
          <Panel title="Accuracy by time horizon" rows={groups.byHorizon} keyLabel="Horizon" />
        </>
      )}
    </AppShell>
  );
}

function Panel({ title, rows, keyLabel }: { title: string; keyLabel: string; rows: Array<{ key: string; total: number; wins: number; winRate: number; avgPnlPct: number }> }) {
  const visible = rows.filter(r => r.total > 0).sort((a, b) => b.total - a.total);
  return (
    <div className="panel p-6 mt-6">
      <h2 className="font-semibold mb-4">{title}</h2>
      {visible.length === 0 ? <p className="text-xs text-muted-foreground">No data.</p> : (
        <table className="w-full text-sm font-mono">
          <thead className="text-xs text-muted-foreground">
            <tr><th className="text-left p-2">{keyLabel}</th><th className="text-right p-2">Signals</th><th className="text-right p-2">Wins</th><th className="text-right p-2">Win rate</th><th className="text-right p-2">Avg P&L</th><th className="w-1/3 p-2"></th></tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.key} className="border-t border-border">
                <td className="p-2">{r.key}</td>
                <td className="p-2 text-right">{r.total}</td>
                <td className="p-2 text-right">{r.wins}</td>
                <td className={`p-2 text-right ${r.winRate >= 0.5 ? "text-success" : "text-destructive"}`}>{fmtPct(r.winRate)}</td>
                <td className={`p-2 text-right ${r.avgPnlPct >= 0 ? "text-success" : "text-destructive"}`}>{fmtPct(r.avgPnlPct)}</td>
                <td className="p-2"><div className="h-2 rounded bg-secondary overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.min(100, r.winRate * 100)}%` }} /></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
