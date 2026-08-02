import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import {
  getExecutionIntel, inspectExecution, runExecutionLearningNow, updateExecutionSettings,
} from "@/lib/executionIntel.functions";
import {
  Brain, CheckCircle2, Crosshair, Gauge, RefreshCw, XCircle, EyeOff,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/execution-intel")({
  head: () => ({
    meta: [
      { title: "Execution Intelligence — NeurlX" },
      { name: "description", content: "Entry timing AI, multi-timeframe confirmation, session performance and the self-learning execution model behind every live order." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ExecutionIntelPage,
});

type Intel = Awaited<ReturnType<typeof getExecutionIntel>>;
type Verdict = Awaited<ReturnType<typeof inspectExecution>>;

const GRADE_TONE: Record<string, string> = {
  "A+": "text-success", A: "text-success", B: "text-primary",
  C: "text-warning", D: "text-warning", F: "text-destructive",
};

function ExecutionIntelPage() {
  const qc = useQueryClient();
  const loadFn = useServerFn(getExecutionIntel);
  const inspectFn = useServerFn(inspectExecution);
  const learnFn = useServerFn(runExecutionLearningNow);
  const saveFn = useServerFn(updateExecutionSettings);

  const [symbol, setSymbol] = useState("BTC-USD");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const { data, isLoading } = useQuery<Intel>({
    queryKey: ["execution-intel"],
    queryFn: () => loadFn() as Promise<Intel>,
    refetchInterval: 60000,
  });

  const mInspect = useMutation({
    mutationFn: () => inspectFn({ data: { symbol, side } }) as Promise<Verdict>,
    onSuccess: setVerdict,
    onError: (e: Error) => toast.error(e.message),
  });
  const mLearn = useMutation({
    mutationFn: () => learnFn({ data: { force: true } }),
    onSuccess: () => {
      toast.success("Execution model re-optimisation complete");
      qc.invalidateQueries({ queryKey: ["execution-intel"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const mSave = useMutation({
    mutationFn: (d: { enabled?: boolean; minConfidence?: number; sessionFilterEnabled?: boolean }) =>
      saveFn({ data: d }),
    onSuccess: () => {
      toast.success("Execution controls updated");
      qc.invalidateQueries({ queryKey: ["execution-intel"] });
    },
  });

  if (isLoading || !data) {
    return <AppShell><div className="text-muted-foreground">Loading execution intelligence…</div></AppShell>;
  }

  const cfg = data.config;

  return (
    <AppShell>
      <PageHeader
        title="Execution Intelligence"
        subtitle="The final gate before any live order: entry timing, multi-timeframe confirmation, order flow, volatility, session edge and a self-learning weight model."
        action={
          <button onClick={() => mLearn.mutate()} disabled={mLearn.isPending}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase hover:bg-secondary">
            <RefreshCw className={`w-3.5 h-3.5 ${mLearn.isPending ? "animate-spin" : ""}`} /> Re-optimise
          </button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Approved" value={String(data.approvals)} sub="Recent decisions" tone="pos" />
        <Metric label="Shadow only" value={String(data.shadowed)} sub="Below confidence floor" />
        <Metric label="Rejected" value={String(data.rejected)} sub="Gate blocked" tone="neg" />
        <Metric label="Avg entry score" value={String(data.avgScore)} sub="0–100" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mt-4">
        <section className="panel p-5">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><Gauge className="w-4 h-4 text-primary" /> Controls</h2>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span>Execution Intelligence gate</span>
              <button onClick={() => mSave.mutate({ enabled: !cfg.enabled })}
                className={`rounded-md border px-3 py-1 text-xs font-mono uppercase ${
                  cfg.enabled ? "border-success/40 text-success" : "border-border text-muted-foreground"
                }`}>{cfg.enabled ? "on" : "off"}</button>
            </div>
            <div className="flex items-center justify-between">
              <span>Session filter</span>
              <button onClick={() => mSave.mutate({ sessionFilterEnabled: !cfg.sessionFilterEnabled })}
                className={`rounded-md border px-3 py-1 text-xs font-mono uppercase ${
                  cfg.sessionFilterEnabled ? "border-success/40 text-success" : "border-border text-muted-foreground"
                }`}>{cfg.sessionFilterEnabled ? "on" : "off"}</button>
            </div>
            <div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Minimum confidence for a live order</span>
                <span className="font-mono">{(cfg.minConfidence * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {[0.85, 0.9, 0.95].map(v => (
                  <button key={v} onClick={() => mSave.mutate({ minConfidence: v })}
                    className={`rounded-md border px-3 py-1.5 text-xs font-mono ${
                      Math.abs(cfg.minConfidence - v) < 1e-6 ? "border-primary text-primary" : "border-border"
                    }`}>{(v * 100).toFixed(0)}%</button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Anything below the floor is recorded as a shadow trade instead of hitting the broker.
              </p>
            </div>
            <div className="pt-1 text-xs text-muted-foreground font-mono">
              model v{cfg.modelVersion} · RR {cfg.minRR}–{cfg.maxRR} · max spread {cfg.maxSpreadBps} bps
            </div>
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><Brain className="w-4 h-4 text-primary" /> Self-learning model</h2>
          <p className="text-sm text-muted-foreground">
            Next automatic re-optimisation in {data.tradesUntilLearning} trades (every {data.learningInterval}).
            Weights only change when the new set beats the incumbent at 95% confidence.
          </p>
          <div className="mt-3 space-y-2">
            {data.models.length === 0 && (
              <p className="text-sm text-muted-foreground">No model versions recorded yet.</p>
            )}
            {data.models.slice(0, 5).map((m) => (
              <div key={String(m.id)} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <div>
                  <p className="font-medium">Version {String(m.version)}{m.active ? " · active" : ""}</p>
                  <p className="text-xs text-muted-foreground">
                    {String(m.trades_evaluated ?? 0)} trades evaluated
                  </p>
                </div>
                <span className="text-xs font-mono text-muted-foreground">
                  {m.created_at ? new Date(String(m.created_at)).toLocaleDateString() : ""}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3 mt-4">
        <section className="panel p-5">
          <h2 className="font-semibold mb-3">Performance by grade</h2>
          {data.byGrade.length === 0
            ? <p className="text-sm text-muted-foreground">No closed trades scored yet.</p>
            : data.byGrade.map(g => (
              <div key={g.key} className="flex items-center justify-between border-b border-border/50 py-1.5 text-sm">
                <span className={`font-mono font-semibold ${GRADE_TONE[g.key] ?? ""}`}>{g.key}</span>
                <span className="text-xs text-muted-foreground">{g.trades} trades</span>
                <span className="font-mono text-xs">{g.winRate}% · {g.avgR}R</span>
              </div>
            ))}
        </section>

        <section className="panel p-5">
          <h2 className="font-semibold mb-3">Performance by session</h2>
          {data.bySession.length === 0
            ? <p className="text-sm text-muted-foreground">No session history yet.</p>
            : data.bySession.map(s => (
              <div key={s.key} className="flex items-center justify-between border-b border-border/50 py-1.5 text-sm">
                <span className="capitalize">{s.key.replace(/_/g, " ")}</span>
                <span className="text-xs text-muted-foreground">{s.trades}</span>
                <span className="font-mono text-xs">{s.winRate}% · {s.avgR}R</span>
              </div>
            ))}
        </section>

        <section className="panel p-5">
          <h2 className="font-semibold mb-3">Entry timing quality</h2>
          {(["perfect", "early", "late", "invalid"] as const).map(k => (
            <div key={k} className="flex items-center justify-between border-b border-border/50 py-1.5 text-sm">
              <span className="capitalize">{k}</span>
              <span className="font-mono">{data.timing[k]}</span>
            </div>
          ))}
        </section>
      </div>

      <section className="panel p-5 mt-4">
        <h2 className="font-semibold flex items-center gap-2"><Crosshair className="w-4 h-4 text-primary" /> Execution inspector</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          Runs the exact gate the autopilot uses — nothing is placed.
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
            className="rounded-md border border-border bg-input px-3 py-1.5 text-sm w-40 font-mono" placeholder="BTC-USD" />
          <select value={side} onChange={e => setSide(e.target.value as "buy" | "sell")}
            className="rounded-md border border-border bg-input px-3 py-1.5 text-sm">
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
          <button onClick={() => mInspect.mutate()} disabled={mInspect.isPending}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">
            {mInspect.isPending ? "Evaluating…" : "Evaluate entry"}
          </button>
        </div>
        {verdict && <VerdictPanel verdict={verdict} />}
      </section>

      <section className="panel p-5 mt-4 overflow-x-auto">
        <h2 className="font-semibold mb-3">Recent execution decisions</h2>
        {data.decisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
        ) : (
          <table className="w-full text-sm min-w-[720px]">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2">Symbol</th><th className="text-left">Side</th>
                <th className="text-right">Score</th><th className="text-left pl-3">Grade</th>
                <th className="text-left pl-3">Verdict</th><th className="text-left pl-3">Session</th>
                <th className="text-left pl-3">When</th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.slice(0, 40).map((d) => (
                <tr key={String(d.id)} className="border-b border-border/50">
                  <td className="py-2 font-mono">{String(d.symbol)}</td>
                  <td className="font-mono text-xs uppercase">{String(d.side)}</td>
                  <td className="text-right font-mono">{Number(d.entry_score ?? 0).toFixed(0)}</td>
                  <td className={`pl-3 font-mono ${GRADE_TONE[String(d.grade)] ?? ""}`}>{String(d.grade ?? "—")}</td>
                  <td className="pl-3">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
                      d.approved ? "bg-success/15 text-success"
                        : d.shadow_only ? "bg-secondary text-muted-foreground"
                        : "bg-destructive/15 text-destructive"
                    }`}>
                      {d.approved ? <CheckCircle2 className="w-3 h-3" />
                        : d.shadow_only ? <EyeOff className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                      {d.approved ? "approved" : d.shadow_only ? "shadow" : "rejected"}
                    </span>
                  </td>
                  <td className="pl-3 text-xs text-muted-foreground capitalize">
                    {String(d.session ?? "—").replace(/_/g, " ")}
                  </td>
                  <td className="pl-3 text-xs text-muted-foreground">
                    {d.created_at ? new Date(String(d.created_at)).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

function VerdictPanel({ verdict }: { verdict: Verdict }) {
  const v = verdict as unknown as {
    approved: boolean; shadowOnly?: boolean; score: number; grade: string;
    confidence?: number; session?: string; rejections?: string[]; notes?: string[];
    stopLoss?: number | null; takeProfit?: number | null; riskReward?: number | null;
    orderType?: string | null;
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={`rounded-full border px-3 py-1 ${
          v.approved ? "border-success/40 text-success"
            : v.shadowOnly ? "border-border text-muted-foreground"
            : "border-destructive/40 text-destructive"
        }`}>
          {v.approved ? "Approved for live" : v.shadowOnly ? "Shadow only" : "Rejected"}
        </span>
        <span className="font-mono">score {Number(v.score).toFixed(0)}</span>
        <span className={`font-mono font-semibold ${GRADE_TONE[v.grade] ?? ""}`}>grade {v.grade}</span>
        {v.confidence != null && <span className="font-mono">confidence {(v.confidence * 100).toFixed(1)}%</span>}
        {v.session && <span className="text-muted-foreground capitalize">{v.session.replace(/_/g, " ")} session</span>}
      </div>
      {(v.stopLoss != null || v.takeProfit != null) && (
        <p className="text-xs font-mono text-muted-foreground">
          {v.orderType ? `${v.orderType} · ` : ""}stop {v.stopLoss ?? "—"} · target {v.takeProfit ?? "—"}
          {v.riskReward != null ? ` · 1:${Number(v.riskReward).toFixed(2)}` : ""}
        </p>
      )}
      {!!v.rejections?.length && (
        <div className="space-y-1">
          {v.rejections.map(r => (
            <p key={r} className="flex items-start gap-2 text-sm text-destructive">
              <XCircle className="w-4 h-4 mt-0.5 shrink-0" />{r}
            </p>
          ))}
        </div>
      )}
      {!!v.notes?.length && (
        <div className="space-y-1">
          {v.notes.map(n => (
            <p key={n} className="text-xs text-muted-foreground">• {n}</p>
          ))}
        </div>
      )}
    </div>
  );
}
