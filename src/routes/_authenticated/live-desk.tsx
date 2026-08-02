import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell, PageHeader, Metric, fmtUsd, fmtNum } from "@/components/AppShell";
import {
  getLiveDesk, getStrategyAnalytics, getPortfolioOverview,
  updateMarginSettings, checkDailyTargets,
} from "@/lib/liveDesk.functions";
import {
  Activity, AlertTriangle, BarChart3, PieChart, RefreshCw, Shield, Wallet,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/live-desk")({
  head: () => ({
    meta: [
      { title: "Live Trading Desk — NeurlX" },
      { name: "description", content: "Real broker equity, margin, open positions and closed trade history for your connected MetaTrader accounts." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LiveDesk,
});

type Tab = "positions" | "history" | "analytics" | "portfolio";

function LiveDesk() {
  const deskFn = useServerFn(getLiveDesk);
  const analyticsFn = useServerFn(getStrategyAnalytics);
  const portfolioFn = useServerFn(getPortfolioOverview);
  const saveFn = useServerFn(updateMarginSettings);
  const targetsFn = useServerFn(checkDailyTargets);
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("positions");
  const [threshold, setThreshold] = useState("");

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["live-desk"], queryFn: () => deskFn(), refetchInterval: 15000,
  });
  const { data: analytics } = useQuery({
    queryKey: ["live-desk-analytics"], queryFn: () => analyticsFn(),
    enabled: tab === "analytics", refetchInterval: 60000,
  });
  const { data: portfolio } = useQuery({
    queryKey: ["live-desk-portfolio"], queryFn: () => portfolioFn(),
    enabled: tab === "portfolio", refetchInterval: 30000,
  });

  if (isLoading || !data) {
    return <AppShell><div className="text-muted-foreground">Loading live broker state…</div></AppShell>;
  }

  const t = data.totals;
  const ccy = t.currency;

  async function saveThreshold() {
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 0 || n > 90) { toast.error("Enter 0–90"); return; }
    await saveFn({ data: { minFreeMarginPct: n } });
    toast.success("Margin threshold saved");
    setThreshold("");
    qc.invalidateQueries({ queryKey: ["live-desk"] });
  }

  async function runTargets() {
    const r = await targetsFn();
    toast.success(
      r.hitTarget ? "Daily profit target reached"
        : r.hitLossLimit ? "Daily loss limit reached"
        : `Today's realized P/L: ${r.dailyPnl.toFixed(2)} ${ccy}`,
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Live Trading Desk"
        subtitle="Real balances, margin and trades pulled directly from your connected MetaTrader accounts."
        action={
          <div className="flex gap-2">
            <button onClick={runTargets}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase hover:bg-secondary">
              Check targets
            </button>
            <button onClick={() => refetch()} disabled={isFetching}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase hover:bg-secondary">
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        }
      />

      {!data.hasLiveAccounts && (
        <div className="panel p-6 text-sm text-muted-foreground">
          No live MetaTrader account connected yet. Connect one in Connected Accounts to see real balances here.
        </div>
      )}

      {data.marginPaused && (
        <div className="panel p-4 mb-4 border-warning/40 bg-warning/5 flex items-center gap-2 text-sm text-warning">
          <AlertTriangle className="w-4 h-4" />
          New trades are paused — free margin is below your {data.minFreeMarginPct}% threshold. Open positions are still managed.
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Balance" value={fmtUsd(t.balance)} sub={ccy} />
        <Metric label="Equity" value={fmtUsd(t.equity)} sub={`Floating ${t.unrealizedPnl.toFixed(2)}`}
          tone={t.unrealizedPnl >= 0 ? "pos" : "neg"} />
        <Metric label="Free margin" value={fmtUsd(t.freeMargin)} sub={`Used ${fmtUsd(t.usedMargin)}`} />
        <Metric label="Margin level" value={t.marginLevel != null ? `${t.marginLevel}%` : "—"}
          sub={`Min ${data.minFreeMarginPct}% free`}
          tone={t.marginLevel != null && t.marginLevel < 200 ? "neg" : "pos"} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
        <Metric label="Today" value={fmtUsd(t.dailyPnl)} tone={t.dailyPnl >= 0 ? "pos" : "neg"} sub="Realized" />
        <Metric label="This week" value={fmtUsd(t.weeklyPnl)} tone={t.weeklyPnl >= 0 ? "pos" : "neg"} sub="Realized" />
        <Metric label="This month" value={fmtUsd(t.monthlyPnl)} tone={t.monthlyPnl >= 0 ? "pos" : "neg"} sub="Realized" />
        <Metric label="Total realized" value={fmtUsd(t.realizedTotal)} tone={t.realizedTotal >= 0 ? "pos" : "neg"}
          sub={`${data.closed.length} closed trades`} />
      </div>

      <div className="panel p-4 mt-4 flex flex-wrap items-end gap-3">
        <div>
          <div className="text-[10px] uppercase font-mono text-muted-foreground flex items-center gap-1">
            <Shield className="w-3 h-3" /> Pause new trades below free margin %
          </div>
          <input value={threshold} onChange={e => setThreshold(e.target.value)}
            placeholder={String(data.minFreeMarginPct)} type="number"
            className="mt-1 w-32 px-3 py-2 rounded-md bg-input border border-border font-mono text-sm" />
        </div>
        <button onClick={saveThreshold}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Save</button>
        <div className="text-xs text-muted-foreground max-w-md">
          Trading resumes automatically once free margin recovers above this level.
        </div>
      </div>

      <div className="mt-5 flex gap-2 border-b border-border">
        {([
          ["positions", "Open positions", Activity],
          ["history", "Closed trades", BarChart3],
          ["analytics", "AI analytics", BarChart3],
          ["portfolio", "Portfolio", PieChart],
        ] as const).map(([key, label, Icon]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-mono uppercase border-b-2 -mb-px ${
              tab === key ? "border-primary text-primary" : "border-transparent text-muted-foreground"
            }`}>
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === "positions" && (
        <div className="panel p-4 mt-4 overflow-x-auto">
          {data.positions.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">No open broker positions.</p>
          ) : (
            <table className="w-full text-sm min-w-[900px]">
              <thead className="text-[10px] font-mono uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2">Symbol</th><th className="text-left">Side</th>
                  <th className="text-right">Lots</th><th className="text-right">Entry</th>
                  <th className="text-right">Current</th><th className="text-right">Floating</th>
                  <th className="text-right">Margin</th><th className="text-right">Swap</th>
                  <th className="text-right">Comm.</th><th className="text-right">Conf.</th>
                  <th className="text-left pl-3">Stop / target</th>
                  <th className="text-left pl-3">Strategy</th><th className="text-left pl-3">Opened</th>
                </tr>
              </thead>
              <tbody>
                {data.positions.map(p => (
                  <tr key={p.ticket} className="border-b border-border/50">
                    <td className="py-2 font-mono">{p.symbol}</td>
                    <td><span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                      p.side === "long" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
                    }`}>{p.side}</span></td>
                    <td className="text-right font-mono">{fmtNum(p.volume, 2)}</td>
                    <td className="text-right font-mono">{fmtNum(p.openPrice, 5)}</td>
                    <td className="text-right font-mono">{p.currentPrice != null ? fmtNum(p.currentPrice, 5) : "—"}</td>
                    <td className={`text-right font-mono ${p.profit >= 0 ? "text-success" : "text-destructive"}`}>
                      {p.profit.toFixed(2)} <span className="opacity-70 text-xs">({p.profitPct.toFixed(2)}%)</span>
                    </td>
                    <td className="text-right font-mono">{p.usedMargin != null ? p.usedMargin.toFixed(2) : "—"}</td>
                    <td className="text-right font-mono">{p.swap.toFixed(2)}</td>
                    <td className="text-right font-mono">{p.commission.toFixed(2)}</td>
                    <td className="text-right font-mono text-primary">
                      {p.aiConfidence != null ? `${(p.aiConfidence * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="pl-3"><TargetsCell position={p} /></td>
                    <td className="pl-3 text-xs text-muted-foreground">{p.strategy ?? "—"}</td>
                    <td className="pl-3 text-xs text-muted-foreground">{new Date(p.openedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}


      {tab === "history" && (
        <div className="panel p-4 mt-4 overflow-x-auto">
          {data.closed.length === 0 ? (
            <p className="text-sm text-muted-foreground p-6 text-center">No closed broker trades yet.</p>
          ) : (
            <table className="w-full text-sm min-w-[900px]">
              <thead className="text-[10px] font-mono uppercase text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2">Symbol</th><th className="text-left">Side</th>
                  <th className="text-right">Lots</th><th className="text-right">Entry</th>
                  <th className="text-right">Exit</th><th className="text-right">Gross</th>
                  <th className="text-right">Fees</th><th className="text-right">Swap</th>
                  <th className="text-right">Net</th><th className="text-right">Held</th>
                  <th className="text-left pl-3">Result</th><th className="text-left pl-3">Exit reason</th>
                  <th className="text-left pl-3">Closed</th>
                </tr>
              </thead>
              <tbody>
                {data.closed.slice(0, 200).map(d => (
                  <tr key={d.ticket} className="border-b border-border/50">
                    <td className="py-2 font-mono">{d.symbol}</td>
                    <td className="font-mono text-xs uppercase">{d.side}</td>
                    <td className="text-right font-mono">{fmtNum(d.volume, 2)}</td>
                    <td className="text-right font-mono">{d.entryPrice != null ? fmtNum(d.entryPrice, 5) : "—"}</td>
                    <td className="text-right font-mono">{d.exitPrice != null ? fmtNum(d.exitPrice, 5) : "—"}</td>
                    <td className="text-right font-mono">{d.grossProfit.toFixed(2)}</td>
                    <td className="text-right font-mono">{d.commission.toFixed(2)}</td>
                    <td className="text-right font-mono">{d.swap.toFixed(2)}</td>
                    <td className={`text-right font-mono ${d.netProfit >= 0 ? "text-success" : "text-destructive"}`}>
                      {d.netProfit.toFixed(2)}
                    </td>
                    <td className="text-right font-mono text-xs">{fmtDuration(d.holdingSeconds)}</td>
                    <td className="pl-3">
                      <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                        d.outcome === "win" ? "bg-success/15 text-success"
                          : d.outcome === "loss" ? "bg-destructive/15 text-destructive"
                          : "bg-secondary text-muted-foreground"
                      }`}>{d.outcome}</span>
                    </td>
                    <td className="pl-3 text-xs text-muted-foreground">{d.exitReason}</td>
                    <td className="pl-3 text-xs text-muted-foreground">{new Date(d.closedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "analytics" && (
        <div className="mt-4 space-y-4">
          {analytics?.overall && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Win rate" value={`${analytics.overall.winRate}%`} sub={`${analytics.overall.trades} trades`} />
              <Metric label="Expectancy" value={fmtUsd(analytics.overall.expectancy)} sub="Per trade" />
              <Metric label="Profit factor" value={String(analytics.overall.profitFactor)} sub="Gross win / loss" />
              <Metric label="Sharpe" value={String(analytics.overall.sharpe)} sub={`Max DD ${fmtUsd(analytics.overall.maxDrawdown)}`} />
            </div>
          )}
          <div className="panel p-4 overflow-x-auto">
            <h2 className="font-semibold mb-3">By strategy</h2>
            {!analytics?.strategies.length ? (
              <p className="text-sm text-muted-foreground">Not enough closed trades yet.</p>
            ) : (
              <table className="w-full text-sm min-w-[800px]">
                <thead className="text-[10px] font-mono uppercase text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left py-2">Strategy</th><th className="text-right">Trades</th>
                    <th className="text-right">Win %</th><th className="text-right">Avg win</th>
                    <th className="text-right">Avg loss</th><th className="text-right">Expectancy</th>
                    <th className="text-right">Sharpe</th><th className="text-right">Max DD</th>
                    <th className="text-right">PF</th><th className="text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.strategies.map(s => (
                    <tr key={s.strategy} className="border-b border-border/50">
                      <td className="py-2">{s.strategy}</td>
                      <td className="text-right font-mono">{s.trades}</td>
                      <td className="text-right font-mono">{s.winRate}%</td>
                      <td className="text-right font-mono text-success">{s.avgWin.toFixed(2)}</td>
                      <td className="text-right font-mono text-destructive">{s.avgLoss.toFixed(2)}</td>
                      <td className="text-right font-mono">{s.expectancy.toFixed(2)}</td>
                      <td className="text-right font-mono">{s.sharpe}</td>
                      <td className="text-right font-mono">{s.maxDrawdown.toFixed(2)}</td>
                      <td className="text-right font-mono">{s.profitFactor}</td>
                      <td className={`text-right font-mono ${s.netProfit >= 0 ? "text-success" : "text-destructive"}`}>
                        {s.netProfit.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === "portfolio" && portfolio && (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Equity" value={fmtUsd(portfolio.equity)} sub={`Return ${portfolio.cumulativeReturnPct}%`}
              tone={portfolio.cumulativeReturnPct >= 0 ? "pos" : "neg"} />
            <Metric label="Floating P/L" value={fmtUsd(portfolio.floatingPnl)}
              tone={portfolio.floatingPnl >= 0 ? "pos" : "neg"} sub="Open positions" />
            <Metric label="Realized P/L" value={fmtUsd(portfolio.realizedPnl)}
              tone={portfolio.realizedPnl >= 0 ? "pos" : "neg"} sub="All closed trades" />
            <Metric label="Net direction" value={`${portfolio.exposureByDirection.netPct}%`}
              sub={`Long ${fmtUsd(portfolio.exposureByDirection.long)} · Short ${fmtUsd(portfolio.exposureByDirection.short)}`} />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="panel p-5">
              <h2 className="font-semibold flex items-center gap-2"><Wallet className="w-4 h-4 text-primary" /> Equity curve</h2>
              <EquitySpark points={portfolio.equityCurve.map(p => p.equity)} />
              <div className="mt-2 text-xs text-muted-foreground">
                {portfolio.equityCurve.length} points · latest {fmtUsd(portfolio.equity)}
              </div>
            </div>
            <div className="panel p-5">
              <h2 className="font-semibold">Exposure by asset</h2>
              {portfolio.exposureByAsset.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">No open exposure.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {portfolio.exposureByAsset.map(a => (
                    <div key={a.symbol}>
                      <div className="flex justify-between text-xs font-mono">
                        <span>{a.symbol}</span><span>{a.pct}% · {fmtUsd(a.notional)}</span>
                      </div>
                      <div className="mt-1 h-1.5 rounded bg-secondary overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${a.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

type DeskPositionRow = Awaited<ReturnType<typeof getLiveDesk>>["positions"][number];

/**
 * Stop/target cell. The AI's calculated levels stay visible at all times; the
 * user can override them and hand control back with one click.
 */
function TargetsCell({ position }: { position: DeskPositionRow }) {
  const qc = useQueryClient();
  const saveTargets = useServerFn(setPositionTargets);
  const [open, setOpen] = useState(false);
  const [sl, setSl] = useState(String(position.stopLoss ?? position.aiStopLoss ?? ""));
  const [tp, setTp] = useState(String(position.takeProfit ?? position.aiTakeProfit ?? ""));

  const mutate = useMutation({
    mutationFn: (vars: { mode: "ai" | "manual" }) =>
      saveTargets({
        data: {
          positionId: position.neurlxPositionId!,
          mode: vars.mode,
          stopLoss: vars.mode === "manual" && sl !== "" ? Number(sl) : null,
          takeProfit: vars.mode === "manual" && tp !== "" ? Number(tp) : null,
        },
      }),
    onSuccess: (_r, vars) => {
      toast.success(vars.mode === "manual" ? "Manual stop / target applied" : "Levels handed back to the AI");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["live-desk"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const manual = position.slTpMode === "manual";

  return (
    <div className="text-xs">
      <div className="font-mono whitespace-nowrap">
        SL {position.stopLoss != null ? fmtNum(position.stopLoss, 5) : "—"}
        {" / "}
        TP {position.takeProfit != null ? fmtNum(position.takeProfit, 5) : "—"}
      </div>
      <div className="mt-0.5 flex items-center gap-2">
        <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
          manual ? "bg-warning/15 text-warning" : "bg-primary/15 text-primary"
        }`}>{manual ? "manual" : "ai"}</span>
        {position.neurlxPositionId && (
          <button onClick={() => setOpen(v => !v)} className="text-[10px] underline text-muted-foreground">
            {open ? "close" : "override"}
          </button>
        )}
      </div>
      {(position.aiStopLoss != null || position.aiTakeProfit != null) && (
        <div className="mt-0.5 text-[10px] text-muted-foreground font-mono">
          AI: {position.aiStopLoss != null ? fmtNum(position.aiStopLoss, 5) : "—"}
          {" / "}
          {position.aiTakeProfit != null ? fmtNum(position.aiTakeProfit, 5) : "—"}
        </div>
      )}
      {open && position.neurlxPositionId && (
        <div className="mt-2 space-y-1.5 rounded-md border border-border p-2 bg-card">
          <input value={sl} onChange={e => setSl(e.target.value)} placeholder="Stop loss"
            className="w-28 px-2 py-1 rounded bg-input border border-border font-mono text-xs" />
          <input value={tp} onChange={e => setTp(e.target.value)} placeholder="Take profit"
            className="w-28 px-2 py-1 rounded bg-input border border-border font-mono text-xs" />
          <div className="flex gap-1.5 pt-0.5">
            <button disabled={mutate.isPending} onClick={() => mutate.mutate({ mode: "manual" })}
              className="rounded bg-primary px-2 py-1 text-[10px] font-mono uppercase text-primary-foreground">
              Apply
            </button>
            <button disabled={mutate.isPending || !manual} onClick={() => mutate.mutate({ mode: "ai" })}
              className="rounded border border-border px-2 py-1 text-[10px] font-mono uppercase disabled:opacity-40">
              Back to AI
            </button>
          </div>
        </div>
      )}
    </div>
  );
}



function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function EquitySpark({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="mt-3 text-sm text-muted-foreground">Not enough history yet.</div>;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) =>
    `${(i / (points.length - 1)) * 100},${40 - ((p - min) / span) * 40}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="mt-3 w-full h-24">
      <polyline points={d} fill="none" strokeWidth="1"
        className={up ? "stroke-success" : "stroke-destructive"} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
