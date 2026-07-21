import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getPerformanceAttribution, getCalibration, getEnvironmentComparison,
  getAlphaDecay, refreshStrategyHealthScores, getStrategyHealthScores,
  generateRecommendations, listRecommendations, decideRecommendation,
  runDriftScan, getDriftHistory, getExecutiveScorecard,
} from "@/lib/validation.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { CheckCircle2, XCircle, RefreshCw, AlertTriangle, TrendingDown, Award, Brain, Activity } from "lucide-react";

export const Route = createFileRoute("/_authenticated/validation")({
  head: () => ({ meta: [{ title: "AI Validation & Optimization — NeurlX" }] }),
  component: ValidationPage,
  errorComponent: ({ error }) => <div className="p-6 text-destructive">Failed to load: {error.message}</div>,
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const cls = (c: string) => ({
  healthy: "bg-emerald-500/15 text-emerald-500",
  warning: "bg-amber-500/15 text-amber-500",
  degrading: "bg-orange-500/15 text-orange-500",
  retire: "bg-red-500/15 text-red-500",
}[c] ?? "bg-muted");

function pct(n: number, d = 1) { return `${(n * 100).toFixed(d)}%`; }
function fmt(n: number, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }

function ValidationPage() {
  const qc = useQueryClient();
  const attr = useServerFn(getPerformanceAttribution);
  const cal = useServerFn(getCalibration);
  const cmp = useServerFn(getEnvironmentComparison);
  const decay = useServerFn(getAlphaDecay);
  const refreshHealth = useServerFn(refreshStrategyHealthScores);
  const health = useServerFn(getStrategyHealthScores);
  const genRecs = useServerFn(generateRecommendations);
  const listRecs = useServerFn(listRecommendations);
  const decide = useServerFn(decideRecommendation);
  const drift = useServerFn(runDriftScan);
  const driftHist = useServerFn(getDriftHistory);
  const scorecard = useServerFn(getExecutiveScorecard);

  const scQ = useQuery({ queryKey: ["val-scorecard"], queryFn: () => scorecard() });
  const attrQ = useQuery({ queryKey: ["val-attribution"], queryFn: () => attr() });
  const calQ = useQuery({ queryKey: ["val-cal"], queryFn: () => cal() });
  const cmpQ = useQuery({ queryKey: ["val-cmp"], queryFn: () => cmp() });
  const decayQ = useQuery({ queryKey: ["val-decay"], queryFn: () => decay() });
  const healthQ = useQuery({ queryKey: ["val-health"], queryFn: () => health() });
  const recsQ = useQuery({ queryKey: ["val-recs"], queryFn: () => listRecs() });
  const driftQ = useQuery({ queryKey: ["val-drift"], queryFn: () => driftHist() });

  const mRefresh = useMutation({
    mutationFn: async () => {
      await Promise.all([
        refreshHealth().catch(() => null),
        drift().catch(() => null),
        genRecs().catch(() => null),
      ]);
    },
    onSuccess: () => {
      qc.invalidateQueries();
      toast.success("Validation snapshot refreshed");
    },
  });

  const mDecide = useMutation({
    mutationFn: (v: { id: string; action: "approve" | "reject" }) => decide({ data: v }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["val-recs"] });
      qc.invalidateQueries({ queryKey: ["val-scorecard"] });
      toast.success("Recommendation updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sc = scQ.data;
  const recs = recsQ.data?.recommendations ?? [];
  const pending = recs.filter((r: { status: string }) => r.status === "pending");

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <Brain className="h-7 w-7 text-primary" />
            AI Performance Validation
          </h1>
          <p className="text-muted-foreground text-sm">
            Continuous, risk-adjusted evaluation. Recommendations require your approval.
          </p>
        </div>
        <Button onClick={() => mRefresh.mutate()} disabled={mRefresh.isPending}>
          <RefreshCw className={`h-4 w-4 mr-2 ${mRefresh.isPending ? "animate-spin" : ""}`} />
          Refresh All
        </Button>
      </div>

      {/* Executive Scorecard */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>AI Health (avg)</CardDescription>
            <CardTitle className="text-3xl">{fmt(sc?.aiScorecard.health_avg ?? 0, 1)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Across all strategies</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Sharpe (live)</CardDescription>
            <CardTitle className="text-3xl">{fmt(sc?.currentEdge.sharpe ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Sample: {sc?.currentEdge.sample ?? 0}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Win Rate</CardDescription>
            <CardTitle className="text-3xl">{pct(sc?.currentEdge.win_rate ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">Max DD: {fmt(sc?.currentEdge.max_drawdown ?? 0)}</CardContent>
        </Card>
        <Card className={sc?.aiScorecard.drift_flag ? "border-amber-500/50" : ""}>
          <CardHeader className="pb-2">
            <CardDescription>Model Drift</CardDescription>
            <CardTitle className="text-2xl flex items-center gap-2">
              {sc?.aiScorecard.drift_flag ? (
                <><AlertTriangle className="h-5 w-5 text-amber-500" /> Detected</>
              ) : ("Stable")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {sc?.aiScorecard.pending_recommendations ?? 0} pending recs
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="attribution">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="attribution">Attribution</TabsTrigger>
          <TabsTrigger value="calibration">Calibration</TabsTrigger>
          <TabsTrigger value="comparison">Live vs Backtest</TabsTrigger>
          <TabsTrigger value="decay">Alpha Decay</TabsTrigger>
          <TabsTrigger value="health">Strategy Health</TabsTrigger>
          <TabsTrigger value="drift">Drift</TabsTrigger>
          <TabsTrigger value="recs">Recommendations {pending.length ? <Badge className="ml-2">{pending.length}</Badge> : null}</TabsTrigger>
        </TabsList>

        {/* Attribution */}
        <TabsContent value="attribution" className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <AttrCard title="By Strategy" rows={attrQ.data?.byStrategy ?? []} />
            <AttrCard title="By Asset" rows={attrQ.data?.byAsset ?? []} />
            <AttrCard title="By Regime" rows={attrQ.data?.byRegime ?? []} />
            <AttrCard title="By Signal Source" rows={attrQ.data?.bySignalSource ?? []} />
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Execution Quality Contribution</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-muted-foreground text-xs">Avg Slippage</div><div className="font-mono">{fmt(attrQ.data?.executionContribution.avg_slippage_bps ?? 0)} bps</div></div>
              <div><div className="text-muted-foreground text-xs">Exec Quality</div><div className="font-mono">{fmt(attrQ.data?.executionContribution.avg_exec_quality ?? 0)}</div></div>
              <div><div className="text-muted-foreground text-xs">Fee Drag</div><div className="font-mono">{fmt(attrQ.data?.executionContribution.total_fee_drag ?? 0)}</div></div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Calibration */}
        <TabsContent value="calibration" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Confidence Calibration Curve</CardTitle>
              <CardDescription>
                Reliability: <span className="font-mono">{pct(calQ.data?.reliabilityScore ?? 0)}</span> ·
                Calibration error: <span className="font-mono">{fmt((calQ.data?.calibrationError ?? 0) * 100, 1)}%</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {(calQ.data?.curve ?? []).map((c) => (
                <div key={c.bucket} className="flex items-center gap-3 text-sm">
                  <div className="w-24 text-muted-foreground">{c.bucket}</div>
                  <div className="flex-1 h-2 bg-muted rounded relative overflow-hidden">
                    <div className="absolute inset-y-0 left-0 bg-primary/40" style={{ width: `${c.predicted * 100}%` }} />
                    <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${c.actual * 100}%`, opacity: 0.9 }} />
                  </div>
                  <div className="w-40 text-xs font-mono text-right">
                    pred {pct(c.predicted)} / actual {pct(c.actual)} · n={c.n}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
          {(calQ.data?.falseConfidence ?? []).length > 0 && (
            <Card className="border-amber-500/50">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" /> False Confidence Detected
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {calQ.data?.falseConfidence.map((f) => (
                  <div key={f.bucket}>Bucket <b>{f.bucket}</b>: overconfident by {pct(f.gap)} (n={f.sample})</div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Comparison */}
        <TabsContent value="comparison">
          <div className="grid md:grid-cols-3 gap-3">
            <CmpCard title="Backtest" data={cmpQ.data?.backtest as Record<string, number> | undefined} />
            <CmpCard title="Shadow" data={cmpQ.data?.shadow as Record<string, number> | undefined} />
            <CmpCard title="Live" data={cmpQ.data?.live as Record<string, number> | undefined} />
          </div>
          {cmpQ.data?.diagnostics.overfitting_suspected && (
            <Card className="mt-4 border-amber-500/50">
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-500" />Overfitting Suspected</CardTitle></CardHeader>
              <CardContent className="text-sm">
                Backtest win rate exceeds live by {pct(cmpQ.data.diagnostics.overfit_gap)}. Reduce strategy weight until live/shadow catch up.
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Alpha Decay */}
        <TabsContent value="decay">
          <Card>
            <CardHeader><CardTitle className="text-base">Alpha Decay Report</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {(decayQ.data?.report ?? []).length === 0 && <div className="text-muted-foreground">Insufficient sample (need ≥10 trades per strategy).</div>}
              {(decayQ.data?.report ?? []).map((r) => (
                <div key={String(r.strategy_id)} className="flex items-center justify-between p-2 rounded bg-muted/50">
                  <div>
                    <div className="font-mono">{String(r.strategy_id)}</div>
                    <div className="text-xs text-muted-foreground">early {fmt(Number(r.early_avg_pnl))} → recent {fmt(Number(r.recent_avg_pnl))}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono ${Number(r.decay_pct) < 0 ? "text-red-500" : "text-emerald-500"}`}>
                      {fmt(Number(r.decay_pct))}%
                    </span>
                    {r.decaying && <Badge variant="destructive"><TrendingDown className="h-3 w-3 mr-1" />decaying</Badge>}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Health */}
        <TabsContent value="health">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Award className="h-4 w-4" />Strategy Leaderboard</CardTitle>
                <Button size="sm" variant="outline" onClick={() => refreshHealth().then(() => { qc.invalidateQueries({ queryKey: ["val-health"] }); toast.success("Recomputed"); })}>Recompute</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {(healthQ.data?.latest ?? []).length === 0 && <div className="text-sm text-muted-foreground">No scored strategies yet.</div>}
              {(healthQ.data?.latest ?? []).map((h) => (
                <div key={String(h.strategy_id)} className="flex items-center justify-between p-3 rounded border">
                  <div>
                    <div className="font-mono text-sm">{String(h.strategy_id)}</div>
                    <div className="text-xs text-muted-foreground">
                      Sharpe {fmt(Number(h.sharpe))} · DD {fmt(Number(h.drawdown))} · Sample {Number(h.sample_size)}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-2xl font-mono font-bold">{fmt(Number(h.score), 1)}</div>
                    <Badge className={cls(String(h.classification))}>{String(h.classification)}</Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Drift */}
        <TabsContent value="drift">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2"><Activity className="h-4 w-4" />Model Drift Snapshots</CardTitle>
                <Button size="sm" variant="outline" onClick={() => drift().then(() => { qc.invalidateQueries({ queryKey: ["val-drift"] }); toast.success("Scan complete"); })}>Run Scan</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {(driftQ.data?.snapshots ?? []).length === 0 && <div className="text-sm text-muted-foreground">No drift scans yet.</div>}
              {(driftQ.data?.snapshots ?? []).map((s) => (
                <div key={String(s.id)} className={`p-3 rounded border ${s.drift_flag ? "border-amber-500/50" : ""}`}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-mono">{String(s.model)}</div>
                    <div className="text-xs text-muted-foreground">{new Date(String(s.created_at)).toLocaleString()}</div>
                  </div>
                  <div className="grid grid-cols-4 gap-2 mt-2 text-xs">
                    <div>Accuracy: <span className="font-mono">{pct(Number(s.accuracy))}</span></div>
                    <div>Brier: <span className="font-mono">{fmt(Number(s.brier))}</span></div>
                    <div>Δ accuracy: <span className="font-mono">{fmt(Number(s.accuracy_delta) * 100)}%</span></div>
                    <div>Dist shift: <span className="font-mono">{fmt(Number(s.distribution_shift) * 100)}%</span></div>
                  </div>
                  {s.drift_flag && <div className="mt-2 text-xs text-amber-500">⚠ {String(s.drift_reason)}</div>}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Recommendations */}
        <TabsContent value="recs">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Optimization Recommendations</CardTitle>
                  <CardDescription>Approval required before any production change.</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => genRecs().then(() => { qc.invalidateQueries({ queryKey: ["val-recs"] }); toast.success("Regenerated"); })}>Generate</Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {recs.length === 0 && <div className="text-sm text-muted-foreground">No recommendations yet.</div>}
              {recs.map((r) => (
                <div key={String(r.id)} className="border rounded p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={r.severity === "high" ? "destructive" : r.severity === "medium" ? "default" : "secondary"}>
                          {String(r.severity)}
                        </Badge>
                        <div className="font-medium">{String(r.title)}</div>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">{String(r.rationale)}</div>
                      <div className="text-xs font-mono mt-2 text-muted-foreground">
                        {String(r.kind)} → {JSON.stringify(r.suggested_change)}
                      </div>
                    </div>
                    <Badge className={
                      r.status === "approved" ? "bg-emerald-500/15 text-emerald-500" :
                      r.status === "rejected" ? "bg-red-500/15 text-red-500" : ""
                    }>{String(r.status)}</Badge>
                  </div>
                  {r.status === "pending" && (
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" onClick={() => mDecide.mutate({ id: String(r.id), action: "approve" })} disabled={mDecide.isPending}>
                        <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => mDecide.mutate({ id: String(r.id), action: "reject" })} disabled={mDecide.isPending}>
                        <XCircle className="h-4 w-4 mr-1" /> Reject
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AttrCard({ title, rows }: { title: string; rows: Array<{ key: string; pnl: number; trades: number; win_rate?: number }> }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-1 text-sm">
        {rows.length === 0 && <div className="text-muted-foreground text-xs">No data</div>}
        {rows.slice(0, 8).map(r => (
          <div key={r.key} className="flex justify-between font-mono text-xs">
            <span className="truncate max-w-[60%]">{r.key}</span>
            <span className={r.pnl >= 0 ? "text-emerald-500" : "text-red-500"}>
              {fmt(r.pnl)} · {r.trades}t{r.win_rate !== undefined ? ` · ${pct(r.win_rate)}` : ""}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CmpCard({ title, data }: { title: string; data?: Record<string, number> }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-1 text-xs font-mono">
        {data && Object.entries(data).map(([k, v]) => (
          <div key={k} className="flex justify-between">
            <span className="text-muted-foreground">{k}</span>
            <span>{typeof v === "number" ? fmt(v) : String(v)}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
