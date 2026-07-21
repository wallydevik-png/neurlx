import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import { getPortfolioRecommendation } from "@/lib/portfolio.functions";
import { Brain, TrendingUp, TrendingDown, Minus, AlertTriangle, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/_authenticated/portfolio")({
  head: () => ({ meta: [{ title: "AI Decision Center — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Portfolio,
});

function ActionBadge({ a }: { a: string }) {
  const map: Record<string, { icon: typeof TrendingUp; cls: string; label: string }> = {
    increase: { icon: TrendingUp, cls: "text-success bg-success/10", label: "Increase" },
    reduce:   { icon: TrendingDown, cls: "text-destructive bg-destructive/10", label: "Reduce" },
    hold:     { icon: Minus, cls: "text-muted-foreground bg-secondary", label: "Hold" },
    avoid:    { icon: ShieldAlert, cls: "text-warning bg-warning/10", label: "Avoid" },
  };
  const it = map[a] ?? map.hold;
  return <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase px-2 py-0.5 rounded ${it.cls}`}><it.icon className="w-3 h-3" />{it.label}</span>;
}

function Portfolio() {
  const fn = useServerFn(getPortfolioRecommendation);
  const { data, isLoading, refetch, isFetching } = useQuery({ queryKey: ["portfolio-rec"], queryFn: () => fn(), refetchInterval: 60000 });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Building portfolio recommendation…</div></AppShell>;
  const r = data.recommendation;

  return (
    <AppShell>
      <PageHeader
        title="AI Decision Center"
        subtitle="Why the AI is making each portfolio-level decision, based on regime, conviction and correlation."
        action={<button onClick={() => refetch()} disabled={isFetching} className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase">{isFetching ? "Refreshing…" : "Refresh"}</button>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Equity" value={fmtUsd(r.equity)} sub={`Cash ${fmtPct(r.cashPct)}`} />
        <Metric label="Target cash" value={fmtPct(r.targetCashPct)} sub={`${data.profile} profile`} />
        <Metric label="Risk score" value={String(r.portfolioRiskScore)} tone={r.portfolioRiskScore > 60 ? "neg" : r.portfolioRiskScore < 30 ? "pos" : undefined} sub="0–100" />
        <Metric label="Regime" value={r.dominantRegime} sub={`${Object.keys(r.regimeMix).length} classes`} />
      </div>

      <div className="panel p-6 mt-4">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">AI reasoning</h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{r.reasoning}</p>
        {data.killSwitch && (
          <div className="mt-3 flex items-center gap-2 text-xs text-destructive font-mono uppercase"><AlertTriangle className="w-3 h-3" /> Kill switch active — recommendations are advisory only.</div>
        )}
      </div>

      <div className="mt-4 grid md:grid-cols-3 gap-4">
        <div className="panel p-6 md:col-span-2">
          <h2 className="font-semibold">Recommended allocation</h2>
          {r.targets.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No conviction-weighted positions today. Cash is the recommendation.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-[10px] font-mono uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2">Asset</th>
                  <th className="text-left">Action</th>
                  <th className="text-right">Current</th>
                  <th className="text-right">Target</th>
                  <th className="text-right">Conv.</th>
                  <th className="text-left pl-4">Reason</th>
                </tr>
              </thead>
              <tbody>
                {r.targets.map(t => (
                  <tr key={t.symbol} className="border-b border-border/50">
                    <td className="py-2 font-mono">{t.symbol}</td>
                    <td><ActionBadge a={t.action} /></td>
                    <td className="text-right font-mono">{fmtPct(t.currentPct)}</td>
                    <td className="text-right font-mono">{fmtPct(t.targetPct)}</td>
                    <td className="text-right font-mono text-primary">{(t.confidence*100).toFixed(0)}%</td>
                    <td className="pl-4 text-xs text-muted-foreground">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="panel p-6">
          <h2 className="font-semibold flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-warning" /> Avoid list</h2>
          {r.avoid.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No assets flagged to avoid.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {r.avoid.map(a => (
                <li key={a.symbol} className="text-sm border-b border-border/50 pb-2">
                  <div className="font-mono">{a.symbol}</div>
                  <div className="text-xs text-muted-foreground">{a.reason}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="mt-4 grid md:grid-cols-2 gap-4">
        <div className="panel p-6">
          <h2 className="font-semibold">Correlation warnings</h2>
          {r.correlationWarnings.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No high-correlation clusters detected among conviction picks.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm text-warning">
              {r.correlationWarnings.map((w, i) => <li key={i}>• {w}</li>)}
            </ul>
          )}
        </div>
        <div className="panel p-6">
          <h2 className="font-semibold">Regime mix</h2>
          <div className="mt-3 space-y-1.5 text-xs">
            {Object.entries(r.regimeMix).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/50 py-1">
                <span className="text-muted-foreground">{k}</span><span className="font-mono">{v}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 text-xs text-muted-foreground">
            Active strategies: <span className="font-mono">{data.activeStrategies.length}</span> · Mode: <span className="font-mono">{data.mode}</span>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
