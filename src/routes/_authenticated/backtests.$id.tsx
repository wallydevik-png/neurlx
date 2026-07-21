import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtPct, fmtUsd, fmtNum } from "@/components/AppShell";
import { getBacktest } from "@/lib/backtest.functions";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts";

export const Route = createFileRoute("/_authenticated/backtests/$id")({
  head: () => ({ meta: [{ title: "Backtest — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: BacktestDetail,
});

type Metrics = {
  totalReturnPct: number; finalEquity: number; winRate: number; trades: number;
  wins: number; losses: number; avgWin: number; avgLoss: number; profitFactor: number;
  sharpe: number; sortino: number; maxDrawdown: number; bestTrade: number; worstTrade: number; avgTradePnl: number;
};
type EqPoint = { ts: number; equity: number };

function BacktestDetail() {
  const { id } = Route.useParams();
  const fn = useServerFn(getBacktest);
  const { data, isLoading } = useQuery({ queryKey: ["backtest", id], queryFn: () => fn({ data: { id } }) });

  if (isLoading || !data?.run) return <AppShell><PageHeader title="Loading…" /></AppShell>;
  const run = data.run;
  const m = (run.metrics ?? {}) as Metrics;
  const equity = ((run.equity_curve ?? []) as EqPoint[]).map(p => ({
    t: new Date(p.ts).toLocaleDateString(), equity: p.equity,
  }));
  const trades = data.trades;
  const best = [...trades].sort((a, b) => Number(b.pnl) - Number(a.pnl)).slice(0, 3);
  const worst = [...trades].sort((a, b) => Number(a.pnl) - Number(b.pnl)).slice(0, 3);

  const isWalk = data.children.length > 0;

  return (
    <AppShell>
      <PageHeader title={run.label ?? `${run.symbol} · ${run.interval}`}
        subtitle={`${new Date(run.from_ts).toLocaleDateString()} → ${new Date(run.to_ts).toLocaleDateString()} · ${trades.length} trades`}
        action={<Link to="/lab" className="text-sm text-muted-foreground hover:text-foreground">← Back to Lab</Link>} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Total return" value={fmtPct(m.totalReturnPct ?? 0)} tone={(m.totalReturnPct ?? 0) >= 0 ? "pos" : "neg"} sub={fmtUsd(m.finalEquity ?? 0)} />
        <Metric label="Win rate" value={fmtPct(m.winRate ?? 0)} sub={`${m.wins ?? 0}W / ${m.losses ?? 0}L`} />
        <Metric label="Profit factor" value={(m.profitFactor ?? 0) === Infinity ? "∞" : Number(m.profitFactor ?? 0).toFixed(2)} />
        <Metric label="Max drawdown" value={fmtPct(m.maxDrawdown ?? 0)} tone="neg" />
        <Metric label="Sharpe" value={Number(m.sharpe ?? 0).toFixed(2)} />
        <Metric label="Sortino" value={Number(m.sortino ?? 0).toFixed(2)} />
        <Metric label="Avg win / loss" value={m.avgLoss > 0 ? (m.avgWin / m.avgLoss).toFixed(2) + "×" : "—"} sub={`avg win ${fmtUsd(m.avgWin ?? 0)}`} />
        <Metric label="Avg trade P&L" value={fmtUsd(m.avgTradePnl ?? 0)} tone={(m.avgTradePnl ?? 0) >= 0 ? "pos" : "neg"} />
      </div>

      <div className="panel p-6 mt-6">
        <h2 className="font-semibold mb-4">Equity curve</h2>
        <div className="h-72">
          <ResponsiveContainer>
            <LineChart data={equity}>
              <XAxis dataKey="t" stroke="oklch(0.68 0.02 250)" fontSize={11} />
              <YAxis stroke="oklch(0.68 0.02 250)" fontSize={11} domain={["dataMin", "dataMax"]} />
              <Tooltip contentStyle={{ background: "oklch(0.18 0.018 250)", border: "1px solid oklch(0.26 0.015 250)", borderRadius: 6, fontSize: 12 }} formatter={(v: number) => fmtUsd(v)} />
              <Line type="monotone" dataKey="equity" stroke="oklch(0.78 0.16 180)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {isWalk && (
        <div className="panel p-6 mt-6">
          <h2 className="font-semibold mb-2">Walk-forward comparison</h2>
          <p className="text-xs text-muted-foreground mb-4">If out-of-sample performance collapses vs. training, the strategy is likely overfit.</p>
          <div className="grid md:grid-cols-3 gap-3">
            {[{ label: "Training", metrics: m }, ...data.children.map(c => ({ label: c.kind.replace("walkforward_",""), metrics: c.metrics as Metrics }))]
              .map((slice, i) => (
                <div key={i} className="panel p-4">
                  <div className="text-xs font-mono text-muted-foreground uppercase">{slice.label}</div>
                  <div className="mt-2 space-y-1 text-sm font-mono">
                    <div>Return: <span className={(slice.metrics?.totalReturnPct ?? 0) >= 0 ? "text-success" : "text-destructive"}>{fmtPct(slice.metrics?.totalReturnPct ?? 0)}</span></div>
                    <div>Win rate: {fmtPct(slice.metrics?.winRate ?? 0)}</div>
                    <div>Sharpe: {Number(slice.metrics?.sharpe ?? 0).toFixed(2)}</div>
                    <div>Max DD: <span className="text-destructive">{fmtPct(slice.metrics?.maxDrawdown ?? 0)}</span></div>
                    <div>Trades: {slice.metrics?.trades ?? 0}</div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <div className="panel p-6">
          <h2 className="font-semibold mb-3">Best trades</h2>
          <TradeMini rows={best} />
        </div>
        <div className="panel p-6">
          <h2 className="font-semibold mb-3">Worst trades</h2>
          <TradeMini rows={worst} />
        </div>
      </div>

      <div className="panel p-6 mt-6">
        <h2 className="font-semibold mb-3">All trades ({trades.length})</h2>
        <div className="overflow-auto max-h-96">
          <table className="w-full text-xs font-mono">
            <thead className="text-muted-foreground sticky top-0 bg-card">
              <tr><th className="text-left p-2">Entry</th><th className="text-left p-2">Side</th><th className="text-right p-2">Entry px</th><th className="text-right p-2">Exit px</th><th className="text-right p-2">P&L</th><th className="text-right p-2">%</th><th className="text-left p-2">Exit</th><th className="text-right p-2">Conf</th><th className="text-left p-2">Regime</th></tr>
            </thead>
            <tbody>
              {trades.map(t => (
                <tr key={t.id} className="border-t border-border">
                  <td className="p-2">{new Date(t.entry_ts).toLocaleString()}</td>
                  <td className="p-2 uppercase">{t.side}</td>
                  <td className="p-2 text-right">{fmtNum(t.entry_price)}</td>
                  <td className="p-2 text-right">{fmtNum(t.exit_price)}</td>
                  <td className={`p-2 text-right ${Number(t.pnl) >= 0 ? "text-success" : "text-destructive"}`}>{fmtUsd(Number(t.pnl))}</td>
                  <td className="p-2 text-right">{fmtPct(Number(t.pnl_pct ?? 0))}</td>
                  <td className="p-2 text-muted-foreground">{t.exit_reason}</td>
                  <td className="p-2 text-right">{Math.round(Number(t.confidence) * 100)}</td>
                  <td className="p-2 text-muted-foreground">{t.market_regime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

function TradeMini({ rows }: { rows: Array<{ id: string; entry_ts: string; side: string; pnl: number | string | null; pnl_pct: number | string | null; market_regime: string | null }> }) {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No trades.</p>;
  return (
    <div className="space-y-2 text-sm font-mono">
      {rows.map(t => (
        <div key={t.id} className="flex justify-between items-center">
          <div className="text-xs text-muted-foreground">{new Date(t.entry_ts).toLocaleDateString()} · {t.side.toUpperCase()} · {t.market_regime}</div>
          <div className={Number(t.pnl) >= 0 ? "text-success" : "text-destructive"}>{fmtUsd(Number(t.pnl))} ({fmtPct(Number(t.pnl_pct ?? 0))})</div>
        </div>
      ))}
    </div>
  );
}
