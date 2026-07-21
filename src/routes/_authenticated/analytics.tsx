import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import { getAdvancedAnalytics, getTaxReport } from "@/lib/advancedAnalytics.functions";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

export const Route = createFileRoute("/_authenticated/analytics")({
  head: () => ({ meta: [{ title: "Analytics — Helix" }, { name: "robots", content: "noindex" }] }),
  component: Analytics,
});

function toCSV(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}

function Analytics() {
  const fetchFn = useServerFn(getAdvancedAnalytics);
  const taxFn = useServerFn(getTaxReport);
  const { data } = useQuery({ queryKey: ["advanced-analytics"], queryFn: () => fetchFn(), refetchInterval: 60000 });

  const exportTax = async () => {
    const y = new Date().getFullYear();
    const res = await taxFn({ data: { year: y } });
    download(`tax-report-${y}.csv`, toCSV(res.rows as unknown as Record<string, unknown>[]));
  };
  const exportTrades = () => {
    if (!data) return;
    download("trades-summary.csv", toCSV(data.symbols as unknown as Record<string, unknown>[]));
  };

  if (!data) return <AppShell><PageHeader title="Analytics" /><div className="panel p-6">Loading…</div></AppShell>;

  const { risk, summary, monthly, symbols, strategies, bestTrades, worstTrades, equityCurve } = data;

  return (
    <AppShell>
      <PageHeader
        title="Advanced Analytics"
        subtitle="Risk-adjusted returns, monthly performance, symbol/strategy attribution, and tax exports."
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={exportTrades}><Download className="w-4 h-4 mr-1" />Trades</Button>
            <Button size="sm" variant="outline" onClick={exportTax}><Download className="w-4 h-4 mr-1" />Tax CSV</Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Total P&L" value={fmtUsd(summary.totalPnl)} tone={summary.totalPnl >= 0 ? "pos" : "neg"} sub={`${summary.totalTrades} trades`} />
        <Metric label="Sharpe" value={risk.sharpe.toFixed(2)} sub={`Sortino ${risk.sortino.toFixed(2)}`} />
        <Metric label="Max drawdown" value={fmtPct(risk.maxDrawdown)} tone="neg" sub={`Calmar ${risk.calmar.toFixed(2)}`} />
        <Metric label="Annualized" value={fmtPct(risk.annualReturn)} sub={`Vol ${fmtPct(risk.volatility)}`} />
      </div>

      <div className="panel p-6 mt-6">
        <h2 className="font-semibold mb-4">Equity curve</h2>
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart data={equityCurve}>
              <CartesianGrid stroke="oklch(0.26 0.015 250)" strokeDasharray="3 3" />
              <XAxis dataKey="date" stroke="oklch(0.68 0.02 250)" fontSize={11} />
              <YAxis stroke="oklch(0.68 0.02 250)" fontSize={11} domain={["dataMin", "dataMax"]} />
              <Tooltip contentStyle={{ background: "oklch(0.18 0.018 250)", border: "1px solid oklch(0.26 0.015 250)", borderRadius: 6, fontSize: 12 }} formatter={(v: number) => fmtUsd(v)} />
              <Line type="monotone" dataKey="equity" stroke="oklch(0.78 0.16 180)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel p-6 mt-4">
        <h2 className="font-semibold mb-4">Monthly returns</h2>
        <div className="h-56">
          <ResponsiveContainer>
            <BarChart data={monthly}>
              <CartesianGrid stroke="oklch(0.26 0.015 250)" strokeDasharray="3 3" />
              <XAxis dataKey="month" stroke="oklch(0.68 0.02 250)" fontSize={11} />
              <YAxis stroke="oklch(0.68 0.02 250)" fontSize={11} />
              <Tooltip contentStyle={{ background: "oklch(0.18 0.018 250)", border: "1px solid oklch(0.26 0.015 250)", borderRadius: 6, fontSize: 12 }} formatter={(v: number) => fmtUsd(v)} />
              <Bar dataKey="pnl" fill="oklch(0.78 0.16 180)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="panel p-6">
          <h2 className="font-semibold mb-3">Symbol attribution</h2>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-xs uppercase">
              <tr><th className="text-left py-2">Symbol</th><th className="text-right">Trades</th><th className="text-right">Win%</th><th className="text-right">P&L</th></tr>
            </thead>
            <tbody>
              {symbols.slice(0, 10).map(s => (
                <tr key={s.symbol} className="border-t border-border/40">
                  <td className="py-2">{s.symbol}</td>
                  <td className="text-right">{s.trades}</td>
                  <td className="text-right">{fmtPct(s.winRate)}</td>
                  <td className={`text-right ${s.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtUsd(s.pnl)}</td>
                </tr>
              ))}
              {!symbols.length && <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No closed trades yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel p-6">
          <h2 className="font-semibold mb-3">Strategy attribution</h2>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-xs uppercase">
              <tr><th className="text-left py-2">Strategy</th><th className="text-right">Trades</th><th className="text-right">Win%</th><th className="text-right">P&L</th></tr>
            </thead>
            <tbody>
              {strategies.slice(0, 10).map(s => (
                <tr key={s.strategy_id} className="border-t border-border/40">
                  <td className="py-2 font-mono text-xs">{s.strategy_id.slice(0, 8)}</td>
                  <td className="text-right">{s.trades}</td>
                  <td className="text-right">{fmtPct(s.winRate)}</td>
                  <td className={`text-right ${s.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtUsd(s.pnl)}</td>
                </tr>
              ))}
              {!strategies.length && <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No data.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4 mt-4">
        <div className="panel p-6">
          <h2 className="font-semibold mb-3 text-emerald-400">Best trades</h2>
          {bestTrades.map((t, i) => (
            <div key={i} className="flex justify-between py-2 border-t border-border/40 first:border-0 text-sm">
              <span>{t.symbol} <span className="text-muted-foreground">{t.side}</span></span>
              <span className="text-emerald-400">{fmtUsd(t.pnl)}</span>
            </div>
          ))}
          {!bestTrades.length && <div className="text-muted-foreground text-sm">—</div>}
        </div>
        <div className="panel p-6">
          <h2 className="font-semibold mb-3 text-rose-400">Worst trades</h2>
          {worstTrades.map((t, i) => (
            <div key={i} className="flex justify-between py-2 border-t border-border/40 first:border-0 text-sm">
              <span>{t.symbol} <span className="text-muted-foreground">{t.side}</span></span>
              <span className="text-rose-400">{fmtUsd(t.pnl)}</span>
            </div>
          ))}
          {!worstTrades.length && <div className="text-muted-foreground text-sm">—</div>}
        </div>
      </div>

      <div className="panel p-6 mt-4 text-xs text-muted-foreground">
        Summary — total fees: {fmtUsd(summary.totalFees)} · avg hold: {summary.avgHoldMin.toFixed(1)} min · Sharpe & Sortino annualized (252d).
        Tax CSV includes symbol, side, qty, entry/exit, realized P&L, and fees for the current year.
      </div>
    </AppShell>
  );
}
