import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import { runOptimizationFn, listOptimizationRuns } from "@/lib/portfolio.functions";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/optimizer")({
  head: () => ({ meta: [{ title: "Strategy Optimizer — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Optimizer,
});

function Optimizer() {
  const runFn = useServerFn(runOptimizationFn);
  const listFn = useServerFn(listOptimizationRuns);
  const qc = useQueryClient();
  const { data: history = [] } = useQuery({ queryKey: ["opt-history"], queryFn: () => listFn() });
  const [form, setForm] = useState({
    symbol: "BTC-USD", interval: "15m" as const, bars: 400,
    confList: "0.55, 0.6, 0.65, 0.7",
    riskList: "0.005, 0.01, 0.015",
    barsList: "20, 40, 60",
  });
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Awaited<ReturnType<typeof runFn>> | null>(null);

  function parseList(s: string) { return s.split(",").map(x => Number(x.trim())).filter(x => !isNaN(x)); }

  async function run() {
    setBusy(true);
    try {
      const res = await runFn({ data: {
        symbol: form.symbol, interval: form.interval, bars: form.bars,
        grid: {
          minConfidence: parseList(form.confList),
          riskPerTradePct: parseList(form.riskList),
          maxBarsInTrade: parseList(form.barsList).map(n => Math.round(n)),
        },
      }});
      setLast(res); qc.invalidateQueries({ queryKey: ["opt-history"] });
      toast.success(`Tested ${res.candidates.length} combinations`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }

  return (
    <AppShell>
      <PageHeader title="Strategy Optimizer" subtitle="Grid-search parameters against historical data to find configurations with a measurable edge." />

      <div className="panel p-6">
        <div className="grid md:grid-cols-3 gap-3">
          <div><label className="text-[10px] font-mono uppercase text-muted-foreground">Symbol</label>
            <input value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm font-mono" /></div>
          <div><label className="text-[10px] font-mono uppercase text-muted-foreground">Interval</label>
            <select value={form.interval} onChange={e => setForm({ ...form, interval: e.target.value as typeof form.interval })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm">
              {(["5m","15m","1h","4h","1d"] as const).map(i => <option key={i}>{i}</option>)}
            </select></div>
          <div><label className="text-[10px] font-mono uppercase text-muted-foreground">Bars</label>
            <input type="number" value={form.bars} onChange={e => setForm({ ...form, bars: Number(e.target.value) })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm font-mono" /></div>
          <div><label className="text-[10px] font-mono uppercase text-muted-foreground">Min confidence values</label>
            <input value={form.confList} onChange={e => setForm({ ...form, confList: e.target.value })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm font-mono" /></div>
          <div><label className="text-[10px] font-mono uppercase text-muted-foreground">Risk % values</label>
            <input value={form.riskList} onChange={e => setForm({ ...form, riskList: e.target.value })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm font-mono" /></div>
          <div><label className="text-[10px] font-mono uppercase text-muted-foreground">Max bars in trade</label>
            <input value={form.barsList} onChange={e => setForm({ ...form, barsList: e.target.value })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm font-mono" /></div>
        </div>
        <button onClick={run} disabled={busy} className="mt-4 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Optimizing…" : "Run optimization"}
        </button>
      </div>

      {last && (
        <div className="panel p-6 mt-4">
          <h2 className="font-semibold">Best configuration</h2>
          <div className="mt-2 text-sm">
            <div className="font-mono text-primary">{JSON.stringify(last.best.params)}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Sortino {last.best.metrics.sortino.toFixed(2)} · Sharpe {last.best.metrics.sharpe.toFixed(2)} · PF {last.best.metrics.profitFactor.toFixed(2)} · Win {(last.best.metrics.winRate*100).toFixed(1)}% · DD {(last.best.metrics.maxDrawdown*100).toFixed(1)}% · {last.best.metrics.trades} trades
            </div>
          </div>
          <table className="mt-4 w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2">Params</th><th className="text-right">Sortino</th><th className="text-right">Sharpe</th>
                <th className="text-right">PF</th><th className="text-right">DD</th><th className="text-right">Trades</th><th className="text-right">Score</th>
              </tr>
            </thead>
            <tbody>
              {last.candidates.slice(0, 20).map((c, i) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1.5 font-mono text-xs">{JSON.stringify(c.params)}</td>
                  <td className="text-right font-mono">{c.metrics.sortino.toFixed(2)}</td>
                  <td className="text-right font-mono">{c.metrics.sharpe.toFixed(2)}</td>
                  <td className="text-right font-mono">{c.metrics.profitFactor.toFixed(2)}</td>
                  <td className="text-right font-mono">{(c.metrics.maxDrawdown*100).toFixed(1)}%</td>
                  <td className="text-right font-mono">{c.metrics.trades}</td>
                  <td className="text-right font-mono text-primary">{isFinite(c.score) ? c.score.toFixed(2) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel p-6 mt-4">
        <h2 className="font-semibold">Recent runs</h2>
        {history.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No optimization runs yet.</p> : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {history.map(h => {
              const m = h.best_metrics as { sortino?: number; sharpe?: number; profitFactor?: number; maxDrawdown?: number; trades?: number } | null;
              return (
                <li key={h.id} className="py-2 flex items-center justify-between">
                  <div>
                    <div className="font-mono text-xs">{h.symbol} · {h.interval} · {h.bars} bars</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{JSON.stringify(h.best_params)}</div>
                  </div>
                  <div className="text-xs font-mono text-muted-foreground">
                    Sortino {Number(m?.sortino ?? 0).toFixed(2)} · PF {Number(m?.profitFactor ?? 0).toFixed(2)} · DD {(Number(m?.maxDrawdown ?? 0)*100).toFixed(1)}%
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
