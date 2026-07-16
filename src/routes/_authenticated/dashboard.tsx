import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import { getDashboard, scanMarketOpportunities, getAiPerformance, listSignals } from "@/lib/trading.functions";
import { Plug, ArrowRight, TrendingUp, TrendingDown, Minus, Sparkles } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — Helix" }, { name: "robots", content: "noindex" }] }),
  component: Dashboard,
});

function Dashboard() {
  const fetchDash = useServerFn(getDashboard);
  const scanFn = useServerFn(scanMarketOpportunities);
  const perfFn = useServerFn(getAiPerformance);
  const sigFn = useServerFn(listSignals);
  const { data, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => fetchDash(), refetchInterval: 10000 });
  const { data: scan = [] } = useQuery({ queryKey: ["market-scan"], queryFn: () => scanFn(), refetchInterval: 60000 });
  const { data: perf } = useQuery({ queryKey: ["ai-perf"], queryFn: () => perfFn(), refetchInterval: 60000 });
  const { data: signals = [] } = useQuery({ queryKey: ["signals"], queryFn: () => sigFn(), refetchInterval: 15000 });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading…</div></AppShell>;

  const cash = Number(data.account?.cash_balance ?? 0);
  const equity = cash;
  const activeSignals = signals.filter(s => s.status === "pending");
  const top = scan.filter(r => r.direction !== "wait").slice(0, 5);

  // Dominant regime among scanned assets
  const regimeCounts = scan.reduce<Record<string, number>>((a, r) => { a[r.regimeLabel] = (a[r.regimeLabel] ?? 0) + 1; return a; }, {});
  const dominantRegime = Object.entries(regimeCounts).sort((a,b) => b[1]-a[1])[0]?.[0] ?? "—";

  return (
    <AppShell>
      <PageHeader title="Dashboard" subtitle="Portfolio, market intelligence, and AI performance in one view." />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Equity" value={fmtUsd(equity)} sub={data.account?.base_currency ?? "USD"} />
        <Metric label="Realized P&L" value={fmtUsd(data.metrics.realizedPnl)} tone={data.metrics.realizedPnl >= 0 ? "pos" : "neg"} />
        <Metric label="AI Win Rate" value={perf && perf.resolved ? fmtPct(perf.winRate) : "—"} sub={perf ? `${perf.resolved} evaluated` : ""} />
        <Metric label="Active Signals" value={String(activeSignals.length)} sub={`${signals.length} total`} />
      </div>

      <div className="mt-6 grid md:grid-cols-3 gap-4">
        <div className="panel p-6 md:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" /> Top opportunities</h2>
            <Link to="/market" className="text-xs text-primary hover:underline inline-flex items-center gap-1">Full scanner <ArrowRight className="w-3 h-3" /></Link>
          </div>
          {top.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No high-conviction opportunities right now.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {top.map(r => (
                <li key={r.symbol} className="py-2.5 flex items-center gap-4 text-sm">
                  <div className="w-20 font-mono">{r.symbol}</div>
                  <div className="w-16">{r.direction === "buy" ? <span className="text-success inline-flex items-center gap-1 text-xs font-mono uppercase"><TrendingUp className="w-3 h-3" />Buy</span> : r.direction === "sell" ? <span className="text-destructive inline-flex items-center gap-1 text-xs font-mono uppercase"><TrendingDown className="w-3 h-3" />Sell</span> : <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-mono uppercase"><Minus className="w-3 h-3"/>Wait</span>}</div>
                  <div className="flex-1 text-xs text-muted-foreground truncate">{r.regimeLabel}</div>
                  <div className="w-20 text-right font-mono">{fmtUsd(r.entry)}</div>
                  <div className="w-14 text-right font-mono text-primary">{r.confidenceScore}%</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="panel p-6">
          <h2 className="font-semibold">Market regime</h2>
          <div className="mt-3 text-2xl font-semibold">{dominantRegime}</div>
          <div className="text-xs text-muted-foreground mt-1">Dominant across {scan.length} scanned assets</div>
          <div className="mt-4 space-y-1.5 text-xs">
            {Object.entries(regimeCounts).map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-border/50 py-1">
                <span className="text-muted-foreground">{k}</span><span className="font-mono">{v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 grid md:grid-cols-2 gap-4">
        <div className="panel p-6">
          <h2 className="font-semibold">AI performance</h2>
          {!perf || perf.resolved === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No signal outcomes evaluated yet. Run "Evaluate outcomes" on the signals page after signals age past 30 min.</p>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
                <div><div className="text-[10px] font-mono uppercase text-muted-foreground">Win rate</div><div className="font-mono">{fmtPct(perf.winRate)}</div></div>
                <div><div className="text-[10px] font-mono uppercase text-muted-foreground">Avg P&L</div><div className="font-mono">{perf.avgPnlPct.toFixed(2)}%</div></div>
                <div><div className="text-[10px] font-mono uppercase text-muted-foreground">Resolved</div><div className="font-mono">{perf.resolved}/{perf.total}</div></div>
              </div>
              <div className="mt-4">
                <div className="text-[10px] font-mono uppercase text-muted-foreground mb-2">Confidence calibration</div>
                <div className="space-y-1">
                  {perf.calibration.filter(b => b.n > 0).map(b => (
                    <div key={b.range} className="flex items-center gap-3 text-xs">
                      <span className="w-16 font-mono text-muted-foreground">{b.range}</span>
                      <div className="flex-1 h-1.5 bg-secondary rounded overflow-hidden"><div className="h-full bg-primary" style={{ width: `${b.winRate*100}%` }} /></div>
                      <span className="w-12 text-right font-mono">{(b.winRate*100).toFixed(0)}%</span>
                      <span className="w-8 text-right font-mono text-muted-foreground">n={b.n}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="panel p-6">
          <h2 className="font-semibold flex items-center gap-2"><Plug className="w-4 h-4 text-primary" /> Connected accounts</h2>
          {data.connections.length === 0 ? (
            <div className="mt-4">
              <p className="text-sm text-muted-foreground">No exchanges connected yet. Start with the paper account.</p>
              <Link to="/accounts/new" className="mt-4 inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground">Add trading platform</Link>
            </div>
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {data.connections.map(c => (
                <li key={c.id} className="py-2.5 flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{c.label}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.connector_id} · {c.status}</div>
                  </div>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded ${c.health === "healthy" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>{c.health}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppShell>
  );
}
