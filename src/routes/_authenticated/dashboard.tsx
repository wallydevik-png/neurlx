import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import { getDashboard, scanMarketOpportunities, getAiPerformance, listSignals, getLiveEquity, getTradeHistory } from "@/lib/trading.functions";
import { Plug, ArrowRight, TrendingUp, TrendingDown, Minus, Sparkles, History } from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({ meta: [{ title: "Dashboard — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Dashboard,
});

function Dashboard() {
  const fetchDash = useServerFn(getDashboard);
  const scanFn = useServerFn(scanMarketOpportunities);
  const perfFn = useServerFn(getAiPerformance);
  const sigFn = useServerFn(listSignals);
  const liveFn = useServerFn(getLiveEquity);
  const historyFn = useServerFn(getTradeHistory);

  const [mode, setMode] = useState<"demo" | "live">(() => {
    if (typeof window === "undefined") return "demo";
    return (localStorage.getItem("neurlx.mode") as "demo" | "live") ?? "demo";
  });
  useEffect(() => { if (typeof window !== "undefined") localStorage.setItem("neurlx.mode", mode); }, [mode]);

  const { data, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => fetchDash(), refetchInterval: 10000 });
  const { data: scan = [] } = useQuery({ queryKey: ["market-scan"], queryFn: () => scanFn(), refetchInterval: 60000 });
  const { data: perf } = useQuery({ queryKey: ["ai-perf"], queryFn: () => perfFn(), refetchInterval: 60000 });
  const { data: signals = [] } = useQuery({ queryKey: ["signals"], queryFn: () => sigFn(), refetchInterval: 15000 });
  const { data: liveEq } = useQuery({ queryKey: ["live-equity"], queryFn: () => liveFn(), refetchInterval: 30000, enabled: mode === "live" });
  const { data: history = [] } = useQuery({ queryKey: ["trade-history"], queryFn: () => historyFn(), refetchInterval: 20000 });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading…</div></AppShell>;

  const paperCash = Number(data.account?.cash_balance ?? 0);
  const liveTotal = Number(liveEq?.totalUsd ?? 0);
  const equity = mode === "live" ? liveTotal : paperCash;
  const equitySub = mode === "live"
    ? (liveEq && liveEq.accounts.length ? `${liveEq.accounts.length} live account${liveEq.accounts.length === 1 ? "" : "s"}` : "No live accounts connected")
    : "Demo · paper";
  const activeSignals = signals.filter(s => s.status === "pending");
  const top = scan.filter(r => r.direction !== "wait").slice(0, 5);

  const regimeCounts = scan.reduce<Record<string, number>>((a, r) => { a[r.regimeLabel] = (a[r.regimeLabel] ?? 0) + 1; return a; }, {});
  const dominantRegime = Object.entries(regimeCounts).sort((a,b) => b[1]-a[1])[0]?.[0] ?? "—";

  return (
    <AppShell>
      <PageHeader title="Dashboard" subtitle="Portfolio, market intelligence, and AI performance in one view." />

      <div className="mb-3 flex items-center justify-between panel px-3 py-2">
        <div className="text-xs text-muted-foreground">
          Viewing <b className={mode === "live" ? "text-success" : "text-foreground"}>{mode === "live" ? "Live" : "Demo"}</b> equity
          {mode === "live" && liveEq && liveEq.accounts.length === 0 && <span className="ml-2 text-warning">— connect a live account to see real balances</span>}
        </div>
        <div className="inline-flex rounded-md border border-border overflow-hidden text-xs font-mono">
          <button onClick={() => setMode("demo")} className={`px-3 py-1.5 ${mode === "demo" ? "bg-primary text-primary-foreground" : "hover:bg-secondary/50"}`}>Demo</button>
          <button onClick={() => setMode("live")} className={`px-3 py-1.5 ${mode === "live" ? "bg-success text-success-foreground" : "hover:bg-secondary/50"}`}>Live</button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Equity" value={fmtUsd(equity)} sub={equitySub} />
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

      <div className="mt-4 panel p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold flex items-center gap-2"><History className="w-4 h-4 text-primary" /> Trade history</h2>
          <span className="text-xs text-muted-foreground font-mono">{history.length} recent</span>
        </div>
        {history.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No trades yet. Turn on Full Autopilot on a connected account to let the AI start trading for you.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] font-mono uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2 font-medium">Time</th>
                  <th className="text-left font-medium">Symbol</th>
                  <th className="text-left font-medium">Side</th>
                  <th className="text-right font-medium">Qty</th>
                  <th className="text-right font-medium">Price</th>
                  <th className="text-left font-medium">Venue</th>
                  <th className="text-left font-medium">Status</th>
                  <th className="text-right font-medium">P&amp;L</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.slice(0, 20).map(h => {
                  const pnl = h.position?.realized_pnl != null ? Number(h.position.realized_pnl) : null;
                  return (
                    <tr key={h.id} className="border-b border-border/50">
                      <td className="py-2 text-muted-foreground">{new Date(h.created_at).toLocaleString(undefined, { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}</td>
                      <td>{h.symbol}</td>
                      <td className={h.side === "buy" ? "text-success" : "text-destructive"}>{h.side.toUpperCase()}</td>
                      <td className="text-right">{Number(h.qty).toFixed(4)}</td>
                      <td className="text-right">{h.filled_price != null ? fmtUsd(Number(h.filled_price)) : "—"}</td>
                      <td className="text-muted-foreground">{h.is_live ? <span className="text-destructive">LIVE</span> : "paper"} · {h.execution_venue}</td>
                      <td className={h.status === "filled" ? "text-success" : h.status === "rejected" || h.status === "error" ? "text-destructive" : "text-muted-foreground"}>{h.status}</td>
                      <td className={`text-right ${pnl == null ? "text-muted-foreground" : pnl >= 0 ? "text-success" : "text-destructive"}`}>{pnl == null ? (h.position?.status === "open" ? "open" : "—") : fmtUsd(pnl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
