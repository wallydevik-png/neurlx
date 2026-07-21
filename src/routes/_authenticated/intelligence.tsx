import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd } from "@/components/AppShell";
import {
  getLiveTradeAnalytics, getTradeAttribution, getLiveStrategyHealth, getComparisonDashboard,
} from "@/lib/liveIntel.functions";
import { Sparkles, Activity, Target, GitCompare } from "lucide-react";

export const Route = createFileRoute("/_authenticated/intelligence")({
  head: () => ({ meta: [{ title: "Live Intelligence — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: IntelPage,
});

function IntelPage() {
  const analyticsFn = useServerFn(getLiveTradeAnalytics);
  const attribFn = useServerFn(getTradeAttribution);
  const healthFn = useServerFn(getLiveStrategyHealth);
  const cmpFn = useServerFn(getComparisonDashboard);

  const analytics = useQuery({ queryKey: ["live-analytics"], queryFn: () => analyticsFn(), refetchInterval: 30000 });
  const attrib = useQuery({ queryKey: ["live-attrib"], queryFn: () => attribFn(), refetchInterval: 30000 });
  const health = useQuery({ queryKey: ["live-strategy-health"], queryFn: () => healthFn(), refetchInterval: 30000 });
  const cmp = useQuery({ queryKey: ["live-comparison"], queryFn: () => cmpFn(), refetchInterval: 30000 });

  if (analytics.isLoading || !analytics.data) return <AppShell><div className="text-muted-foreground">Loading intelligence…</div></AppShell>;

  const a = analytics.data;
  const overview = a.overview;

  return (
    <AppShell>
      <PageHeader
        title="Live Trading Intelligence"
        subtitle="Calibration, attribution, and health signals derived from your closed trades. Assisted mode only — nothing here changes autonomous state."
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Metric label="Closed trades" value={String(overview.n)} />
        <Metric label="Win rate" value={`${(overview.winRate * 100).toFixed(1)}%`}
          tone={overview.winRate >= 0.5 ? "pos" : "neg"} />
        <Metric label="Total P&L" value={fmtUsd(overview.totalPnl)}
          tone={overview.totalPnl >= 0 ? "pos" : "neg"} />
        <Metric label="Profit factor"
          value={overview.profitFactor == null ? "—" : overview.profitFactor.toFixed(2)} />
        <Metric label="Avg slip / latency" value={`${overview.avgSlippageBps.toFixed(1)}bps · ${overview.avgLatencyMs}ms`} />
      </div>

      {/* Calibration */}
      <section className="panel p-5 mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Prediction calibration</h2>
        </div>
        {a.calibration.length === 0 ? (
          <Empty msg="No calibration data yet — close a few trades." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2">Confidence bucket</th>
                <th className="text-right">Trades</th>
                <th className="text-right">Predicted win</th>
                <th className="text-right">Actual win</th>
                <th className="text-right">Delta</th>
                <th className="text-right">P&L</th>
              </tr>
            </thead>
            <tbody>
              {a.calibration.map(c => {
                const delta = c.winRate - c.predictedRate;
                return (
                  <tr key={c.bucket} className="border-b border-border/50">
                    <td className="py-2 font-mono">{c.bucket}</td>
                    <td className="text-right font-mono">{c.n}</td>
                    <td className="text-right font-mono">{(c.predictedRate * 100).toFixed(0)}%</td>
                    <td className="text-right font-mono">{(c.winRate * 100).toFixed(0)}%</td>
                    <td className={`text-right font-mono ${delta >= 0 ? "text-success" : "text-destructive"}`}>
                      {delta >= 0 ? "+" : ""}{(delta * 100).toFixed(1)}%
                    </td>
                    <td className={`text-right font-mono ${c.totalPnl >= 0 ? "text-success" : "text-destructive"}`}>
                      {fmtUsd(c.totalPnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <BreakdownTable title="By asset" rows={a.byAsset} />
        <BreakdownTable title="By regime" rows={a.byRegime} />
        <BreakdownTable title="By strategy" rows={a.byStrategy} />
        <BreakdownTable title="By holding period" rows={a.byHorizon} />
      </div>

      {/* Attribution */}
      <section className="panel p-5 mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Trade attribution</h2>
        </div>
        {!attrib.data ? <Empty msg="Loading…" /> : (
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <div className="text-xs uppercase font-mono text-muted-foreground mb-2">Indicator contribution</div>
              {attrib.data.indicators.length === 0 ? (
                <p className="text-sm text-muted-foreground">No attribution recorded.</p>
              ) : (
                <ul className="space-y-1.5 text-sm font-mono">
                  {attrib.data.indicators.slice(0, 8).map(i => (
                    <li key={i.name} className="flex items-center justify-between">
                      <span>{i.name}</span>
                      <span className="flex gap-3">
                        <span className="text-success">{i.wins}W</span>
                        <span className="text-destructive">{i.losses}L</span>
                        <span className={i.totalPnl >= 0 ? "text-success" : "text-destructive"}>
                          {fmtUsd(i.totalPnl)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="text-xs uppercase font-mono text-muted-foreground mb-2">Execution impact</div>
              <div className="text-sm space-y-1">
                <div>Helped: <span className="font-mono text-success">{attrib.data.execution.helped}</span></div>
                <div>Hurt: <span className="font-mono text-destructive">{attrib.data.execution.hurt}</span></div>
              </div>
              <div className="text-xs uppercase font-mono text-muted-foreground mt-4 mb-2">AI prediction accuracy</div>
              <div className="text-sm space-y-1">
                <div>Correct: <span className="font-mono text-success">{attrib.data.aiPrediction.correct}</span></div>
                <div>Wrong: <span className="font-mono text-destructive">{attrib.data.aiPrediction.wrong}</span></div>
              </div>
            </div>
            <div>
              <div className="text-xs uppercase font-mono text-muted-foreground mb-2">Exit reasons</div>
              <div className="text-sm space-y-1">
                <div>Take profit: <span className="font-mono text-success">{attrib.data.exits.tpHit}</span></div>
                <div>Stop loss: <span className="font-mono text-destructive">{attrib.data.exits.stopHit}</span></div>
                <div>Manual: <span className="font-mono">{attrib.data.exits.manual}</span></div>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Strategy health */}
      <section className="panel p-5 mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Live strategy health</h2>
        </div>
        {!health.data || health.data.length === 0 ? (
          <Empty msg="No strategies with live activity yet." />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2">Strategy</th>
                <th className="text-right">30d trades</th>
                <th className="text-right">7d WR</th>
                <th className="text-right">30d WR</th>
                <th className="text-right">30d P&L</th>
                <th className="text-right">Drawdown</th>
                <th className="text-right">Flag</th>
              </tr>
            </thead>
            <tbody>
              {health.data.map(h => (
                <tr key={h.id} className="border-b border-border/50">
                  <td className="py-2 font-mono truncate max-w-[14rem]">{h.name}</td>
                  <td className="text-right font-mono">{h.trades30}</td>
                  <td className="text-right font-mono">{(h.winRate7 * 100).toFixed(0)}%</td>
                  <td className="text-right font-mono">{(h.winRate30 * 100).toFixed(0)}%</td>
                  <td className={`text-right font-mono ${h.pnl30 >= 0 ? "text-success" : "text-destructive"}`}>{fmtUsd(h.pnl30)}</td>
                  <td className="text-right font-mono text-destructive">-{fmtUsd(h.drawdown)}</td>
                  <td className="text-right">
                    <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                      h.liveFlag === "healthy" ? "bg-success/15 text-success"
                      : h.liveFlag === "degrading" ? "bg-warning/15 text-warning"
                      : "bg-destructive/15 text-destructive"
                    }`}>{h.liveFlag}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Comparison */}
      <section className="panel p-5 mt-6">
        <div className="flex items-center gap-2 mb-3">
          <GitCompare className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Backtest vs Shadow vs Live</h2>
        </div>
        {!cmp.data ? <Empty msg="Loading…" /> : (
          <table className="w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2">Source</th>
                <th className="text-right">Trades</th>
                <th className="text-right">Win rate</th>
                <th className="text-right">Total P&L</th>
                <th className="text-right">Sharpe</th>
                <th className="text-right">Max DD</th>
              </tr>
            </thead>
            <tbody>
              <CmpRow label="Backtest (best)" m={cmp.data.backtest} />
              <CmpRow label="Shadow" m={cmp.data.shadow} />
              <CmpRow label="Live" m={cmp.data.live} />
            </tbody>
          </table>
        )}
        {cmp.data && (
          <div className="mt-3 text-xs text-muted-foreground">
            Live execution cost: avg slippage {cmp.data.execution.avgSlippageBps.toFixed(1)}bps ·
            avg quality {cmp.data.execution.avgQuality.toFixed(1)}/10 ·
            total fees {fmtUsd(cmp.data.execution.totalFees)}
          </div>
        )}
      </section>
    </AppShell>
  );
}

function CmpRow({ label, m }: {
  label: string;
  m: null | { n: number; winRate: number; totalPnl: number; sharpe: number; maxDd: number };
}) {
  if (!m || m.n === 0) return (
    <tr className="border-b border-border/50">
      <td className="py-2 font-mono">{label}</td>
      <td colSpan={5} className="text-right text-muted-foreground text-xs">no data</td>
    </tr>
  );
  return (
    <tr className="border-b border-border/50">
      <td className="py-2 font-mono">{label}</td>
      <td className="text-right font-mono">{m.n}</td>
      <td className="text-right font-mono">{(m.winRate * 100).toFixed(1)}%</td>
      <td className={`text-right font-mono ${m.totalPnl >= 0 ? "text-success" : "text-destructive"}`}>{fmtUsd(m.totalPnl)}</td>
      <td className="text-right font-mono">{m.sharpe.toFixed(2)}</td>
      <td className="text-right font-mono text-destructive">-{fmtUsd(m.maxDd)}</td>
    </tr>
  );
}

function BreakdownTable({ title, rows }: {
  title: string;
  rows: { key: string; n: number; winRate: number; totalPnl: number; avgConf: number }[];
}) {
  return (
    <div className="panel p-4 sm:p-6">
      <h3 className="font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No data.</p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-[10px] font-mono uppercase text-muted-foreground">
            <tr className="border-b border-border">
              <th className="text-left py-1.5">Bucket</th>
              <th className="text-right">n</th>
              <th className="text-right">Win%</th>
              <th className="text-right">Avg conf</th>
              <th className="text-right">P&L</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map(r => (
              <tr key={r.key} className="border-b border-border/50">
                <td className="py-1.5 font-mono truncate max-w-[12rem]">{r.key}</td>
                <td className="text-right font-mono">{r.n}</td>
                <td className="text-right font-mono">{(r.winRate * 100).toFixed(0)}%</td>
                <td className="text-right font-mono">{(r.avgConf * 100).toFixed(0)}%</td>
                <td className={`text-right font-mono ${r.totalPnl >= 0 ? "text-success" : "text-destructive"}`}>{fmtUsd(r.totalPnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-center py-8 text-sm text-muted-foreground">{msg}</div>;
}
