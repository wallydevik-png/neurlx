import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd } from "@/components/AppShell";
import { getReadinessScore, getShadowAnalytics } from "@/lib/monitoring.functions";
import { Gauge, ShieldAlert, ShieldCheck } from "lucide-react";

export const Route = createFileRoute("/_authenticated/readiness")({
  head: () => ({ meta: [{ title: "AI Readiness — Helix" }, { name: "robots", content: "noindex" }] }),
  component: Readiness,
});

const TIER_COLOR: Record<string, string> = {
  not_ready: "text-destructive",
  testing: "text-warning",
  almost_ready: "text-primary",
  ready_for_assisted: "text-success",
};

function Readiness() {
  const scoreFn = useServerFn(getReadinessScore);
  const analyticsFn = useServerFn(getShadowAnalytics);
  const { data, isLoading } = useQuery({ queryKey: ["readiness"], queryFn: () => scoreFn(), refetchInterval: 60000 });
  const { data: analytics } = useQuery({ queryKey: ["shadow-analytics"], queryFn: () => analyticsFn(), refetchInterval: 60000 });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading…</div></AppShell>;

  const tone = TIER_COLOR[data.tier] ?? "text-muted-foreground";
  const Icon = data.tier === "ready_for_assisted" ? ShieldCheck : ShieldAlert;

  return (
    <AppShell>
      <PageHeader
        title="AI Readiness Score"
        subtitle="Composite score across backtests, walk-forward, shadow trading, drawdown, calibration, and strategy health. Live trading stays disabled regardless."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <div className="panel p-6 md:col-span-1">
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-primary" />
            <div className="text-xs font-mono uppercase text-muted-foreground">Overall</div>
          </div>
          <div className="mt-3 text-6xl font-mono tabular">{data.score}<span className="text-2xl text-muted-foreground">/100</span></div>
          <div className={`mt-3 inline-flex items-center gap-2 text-sm font-semibold ${tone}`}>
            <Icon className="w-4 h-4" /> {data.tierLabel}
          </div>
          <div className="mt-4 h-2 rounded-full bg-secondary overflow-hidden">
            <div className={`h-full transition-all ${
              data.tier === "ready_for_assisted" ? "bg-success"
              : data.tier === "almost_ready" ? "bg-primary"
              : data.tier === "testing" ? "bg-warning" : "bg-destructive"
            }`} style={{ width: `${data.score}%` }} />
          </div>
          <div className="mt-4 text-xs text-muted-foreground">
            {data.tier === "ready_for_assisted"
              ? "You've met the bar for Assisted mode consideration. Live execution remains disabled in this build."
              : "Keep validating on paper and shadow — the score updates as you accumulate evidence."}
          </div>
        </div>

        <div className="panel p-6 md:col-span-2">
          <h2 className="font-semibold">Component scores</h2>
          <div className="mt-4 space-y-3">
            {data.buckets.map(b => (
              <div key={b.label}>
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{b.label}</span>
                  <span className="font-mono">{Math.round(b.score * 100)} <span className="text-muted-foreground text-xs">· w{(b.weight*100).toFixed(0)}</span></span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${b.score * 100}%` }} />
                </div>
                <div className="text-xs text-muted-foreground mt-1">{b.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {analytics && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
            <Metric label="Shadow trades" value={String(analytics.benchmark.n)} />
            <Metric label="Strategy avg" value={`${(analytics.benchmark.strategyAvgPct*100).toFixed(2)}%`}
              tone={analytics.benchmark.strategyAvgPct >= 0 ? "pos" : "neg"} />
            <Metric label="Buy & hold avg" value={`${(analytics.benchmark.buyHoldAvgPct*100).toFixed(2)}%`}
              tone={analytics.benchmark.buyHoldAvgPct >= 0 ? "pos" : "neg"} />
            <Metric label="Edge" value={`${(analytics.benchmark.edgePct*100).toFixed(2)}%`}
              tone={analytics.benchmark.edgePct >= 0 ? "pos" : "neg"} />
          </div>

          <div className="grid gap-4 md:grid-cols-2 mt-4">
            <BreakdownTable title="Performance by regime" rows={analytics.byRegime} />
            <BreakdownTable title="Performance by asset" rows={analytics.byAsset} />
          </div>
        </>
      )}

      <div className="mt-6 text-xs text-muted-foreground">
        Need to raise the score? Run more <Link to="/lab" className="text-primary hover:underline">backtests</Link>,
        record and evaluate <Link to="/shadow" className="text-primary hover:underline">shadow trades</Link>,
        and review <Link to="/strategies" className="text-primary hover:underline">strategy health</Link>.
      </div>
    </AppShell>
  );
}

function BreakdownTable({ title, rows }: {
  title: string;
  rows: { key: string; n: number; winRate: number; totalPnl: number; avgPnlPct: number }[];
}) {
  return (
    <div className="panel p-4 sm:p-6">
      <h3 className="font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No closed shadow trades yet.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-[10px] font-mono uppercase text-muted-foreground">
            <tr className="border-b border-border">
              <th className="text-left py-1.5">Bucket</th>
              <th className="text-right">n</th>
              <th className="text-right">Win%</th>
              <th className="text-right">Avg P&L%</th>
              <th className="text-right">Total P&L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key} className="border-b border-border/50">
                <td className="py-1.5 font-mono truncate max-w-[10rem]">{r.key}</td>
                <td className="text-right font-mono">{r.n}</td>
                <td className="text-right font-mono">{(r.winRate*100).toFixed(0)}%</td>
                <td className={`text-right font-mono ${r.avgPnlPct >= 0 ? "text-success" : "text-destructive"}`}>{(r.avgPnlPct*100).toFixed(2)}%</td>
                <td className={`text-right font-mono ${r.totalPnl >= 0 ? "text-success" : "text-destructive"}`}>{fmtUsd(r.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
