import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import {
  getRiskPolicy, getLearningState, inspectEntry,
  runLearningReview, updateInstitutionalSettings, resetRecoveryPause,
} from "@/lib/institutional.functions";
import { ShieldCheck, Brain, Gauge, AlertTriangle, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/risk-engine")({
  head: () => ({ meta: [
    { title: "Institutional Risk Engine — NeurlX" },
    { name: "description", content: "Drawdown circuit breakers, dynamic position risk, correlation budgets and the self-learning strategy review." },
    { name: "robots", content: "noindex" },
  ]}),
  component: RiskEnginePage,
});

type Policy = Awaited<ReturnType<typeof getRiskPolicy>>;
type Learning = Awaited<ReturnType<typeof getLearningState>>;
type Entry = Awaited<ReturnType<typeof inspectEntry>>;

function Bar({ value, limit, label }: { value: number; limit: number; label: string }) {
  const pct = Math.min(100, limit > 0 ? (value / limit) * 100 : 0);
  const tone = pct >= 100 ? "bg-destructive" : pct >= 66 ? "bg-warning" : "bg-success";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono">{value.toFixed(2)}% / {limit}%</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RiskEnginePage() {
  const qc = useQueryClient();
  const fetchPolicy = useServerFn(getRiskPolicy);
  const fetchLearning = useServerFn(getLearningState);
  const inspect = useServerFn(inspectEntry);
  const review = useServerFn(runLearningReview);
  const save = useServerFn(updateInstitutionalSettings);
  const clearPause = useServerFn(resetRecoveryPause);

  const [symbol, setSymbol] = useState("BTC-USD");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [entry, setEntry] = useState<Entry | null>(null);

  const pq = useQuery<Policy>({ queryKey: ["risk-policy"], queryFn: () => fetchPolicy() as Promise<Policy>, refetchInterval: 60000 });
  const lq = useQuery<Learning>({ queryKey: ["learning-state"], queryFn: () => fetchLearning() as Promise<Learning> });

  const mInspect = useMutation({
    mutationFn: () => inspect({ data: { symbol, side } }) as Promise<Entry>,
    onSuccess: (r) => setEntry(r),
    onError: (e: Error) => toast.error(e.message),
  });
  const mReview = useMutation({
    mutationFn: () => review({ data: { force: true } }),
    onSuccess: (r) => {
      toast.success(r.ran ? "Strategy review complete" : r.reason ?? "Nothing to review");
      qc.invalidateQueries({ queryKey: ["learning-state"] });
    },
  });
  const mPause = useMutation({
    mutationFn: () => clearPause(),
    onSuccess: () => { toast.success("Recovery pause cleared"); qc.invalidateQueries({ queryKey: ["risk-policy"] }); },
  });
  const mSave = useMutation({
    mutationFn: (d: Parameters<typeof save>[0]["data"]) => save({ data: d }),
    onSuccess: () => { toast.success("Risk controls updated"); qc.invalidateQueries({ queryKey: ["risk-policy"] }); },
  });

  const p = pq.data;

  return (
    <AppShell>
      <PageHeader
        title="Institutional Risk Engine"
        subtitle="Capital preservation first: drawdown circuit breakers, conviction-scaled position risk, correlation budgets and a self-learning strategy review."
      />

      {p && (
        <div className={`rounded-xl border p-4 mb-6 ${p.tradingAllowed ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5"}`}>
          <div className="flex items-start gap-3">
            {p.tradingAllowed
              ? <ShieldCheck className="h-5 w-5 text-success mt-0.5" />
              : <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />}
            <div className="flex-1">
              <p className="font-medium">
                {p.tradingAllowed ? "Trading permitted — all capital-protection checks clear" : "Trading halted by the risk engine"}
              </p>
              {p.blocks.map(b => (
                <p key={b} className="text-sm text-muted-foreground mt-1">• {b}</p>
              ))}
              {p.capitalPreservation && (
                <p className="text-sm text-warning mt-1">
                  Capital-preservation mode active — per-trade risk floored at 0.25%.
                </p>
              )}
            </div>
            {p.recoveryPauseUntil && (
              <button onClick={() => mPause.mutate()} className="text-xs rounded-md border px-3 py-1.5 hover:bg-muted">
                Clear recovery pause
              </button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <Metric label="Equity" value={p ? `$${p.equity.toFixed(2)}` : "—"} />
        <Metric label="High-water mark" value={p ? `$${p.highWater.toFixed(2)}` : "—"} />
        <Metric label="Open / max positions" value={p ? `${p.openPositions} / ${p.maxOpenPositions}` : "—"} />
        <Metric label="Consecutive losses" value={p ? String(p.consecutiveLosses) : "—"} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border p-5">
          <h2 className="font-semibold flex items-center gap-2 mb-4"><Gauge className="h-4 w-4" /> Drawdown circuit breakers</h2>
          {p ? (
            <div className="space-y-4">
              <Bar label="Daily drawdown" value={p.dailyDrawdownPct} limit={p.limits.dailyPct} />
              <Bar label="Weekly drawdown" value={p.weeklyDrawdownPct} limit={p.limits.weeklyPct} />
              <Bar label="Account drawdown (from high-water)" value={p.totalDrawdownPct} limit={p.limits.accountPct} />
              <div className="grid grid-cols-2 gap-3 pt-2 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">Base risk / trade</p>
                  <p className="font-mono">{(p.limits.baseRiskPct * 100).toFixed(2)}%</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Correlated cluster budget</p>
                  <p className="font-mono">{p.limits.maxCorrelatedRiskPct}%</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">Today realized</p>
                  <p className={`font-mono ${p.dailyPnl >= 0 ? "text-success" : "text-destructive"}`}>${p.dailyPnl.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">This week realized</p>
                  <p className={`font-mono ${p.weeklyPnl >= 0 ? "text-success" : "text-destructive"}`}>${p.weeklyPnl.toFixed(2)}</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-2">
                {[0.0025, 0.005, 0.01].map(r => (
                  <button key={r}
                    onClick={() => mSave.mutate({ riskPerTradePct: r })}
                    className={`text-xs rounded-md border px-3 py-1.5 hover:bg-muted ${Math.abs(p.limits.baseRiskPct - r) < 1e-6 ? "border-primary text-primary" : ""}`}>
                    Base risk {(r * 100).toFixed(2)}%
                  </button>
                ))}
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">Loading…</p>}
        </section>

        <section className="rounded-xl border p-5">
          <h2 className="font-semibold flex items-center gap-2 mb-4"><Brain className="h-4 w-4" /> Self-learning review</h2>
          {lq.data ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {lq.data.closedTrades} closed trades · next automatic review in {lq.data.tradesUntilReview} trades
                (every {lq.data.interval}).
              </p>
              <div className="space-y-2">
                {lq.data.weights.length === 0 && (
                  <p className="text-sm text-muted-foreground">No strategy scores yet — run a review once you have at least 10 closed trades.</p>
                )}
                {lq.data.weights.map(w => (
                  <div key={w.strategy} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{w.strategy.replace(/_/g, " ")}</p>
                      <p className="text-xs text-muted-foreground">
                        PF {w.profitFactor.toFixed(2)} · win {(w.winRate * 100).toFixed(0)}% · {w.sampleSize} trades
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono">×{w.weight.toFixed(2)}</p>
                      <p className={`text-xs ${w.enabled ? "text-success" : "text-destructive"}`}>
                        {w.enabled ? "enabled" : "disabled"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => mReview.mutate()} disabled={mReview.isPending}
                className="text-xs rounded-md border px-3 py-1.5 hover:bg-muted inline-flex items-center gap-2">
                <RefreshCw className={`h-3.5 w-3.5 ${mReview.isPending ? "animate-spin" : ""}`} /> Run review now
              </button>
            </div>
          ) : <p className="text-sm text-muted-foreground">Loading…</p>}
        </section>
      </div>

      <section className="rounded-xl border p-5 mt-6">
        <h2 className="font-semibold mb-1">Entry gate inspector</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Runs the exact filter stack the autonomous engine uses. Every check must pass — there is no partial credit.
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="rounded-md border bg-background px-3 py-1.5 text-sm w-40" placeholder="BTC-USD" />
          <select value={side} onChange={e => setSide(e.target.value as "buy" | "sell")}
            className="rounded-md border bg-background px-3 py-1.5 text-sm">
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
          <button onClick={() => mInspect.mutate()} disabled={mInspect.isPending}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">
            {mInspect.isPending ? "Evaluating…" : "Evaluate setup"}
          </button>
        </div>
        {entry && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className={`rounded-full border px-3 py-1 ${entry.approved ? "border-success/40 text-success" : "border-destructive/40 text-destructive"}`}>
                {entry.approved ? "Approved" : "Rejected"}
              </span>
              <span className="font-mono">confidence {(entry.confidence * 100).toFixed(1)}%</span>
              <span className="text-muted-foreground">{entry.regime.label} · ADX {entry.regime.adx ?? "n/a"} · strategy {entry.strategy.replace(/_/g, " ")}</span>
            </div>
            <p className="text-sm text-muted-foreground">{entry.reasoning}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {entry.checks.map(c => (
                <div key={c.name} className="flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
                  {c.passed
                    ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
                    : <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
                  <div>
                    <p className="font-medium">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.detail}</p>
                  </div>
                </div>
              ))}
            </div>
            {entry.frame && (
              <p className="text-xs text-muted-foreground font-mono">
                entry {entry.frame.entry} · stop {entry.frame.stopLoss} ({entry.frame.basis}) · target {entry.frame.takeProfit} · 1:{entry.frame.riskReward} · ATR {entry.frame.atr.toFixed(6)}
              </p>
            )}
          </div>
        )}
      </section>
    </AppShell>
  );
}
