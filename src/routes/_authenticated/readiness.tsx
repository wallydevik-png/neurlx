import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  Gauge, ShieldCheck, ShieldAlert, CheckCircle2, XCircle, AlertTriangle,
  TrendingUp, Brain, Zap, Shield, HeartPulse, FileText, ClipboardCheck,
  History as HistoryIcon, Layers, Sparkles, RefreshCw,
} from "lucide-react";
import {
  computeReadinessScore, evaluateDeploymentEligibility,
  generateCapitalScaleRecommendation, listCapitalRecommendations, decideCapitalRecommendation,
  runEmergencyChecks, getLastEmergencyCheck,
  generateAuditReport, listAuditReports,
  generateAiSelfEvaluation, listSelfEvaluations,
  getProductionChecklist, setChecklistItem,
  captureConfigurationSnapshot, listConfigurationSnapshots,
  acknowledgeRisk, listAcknowledgments,
  listDeploymentHistory, listApprovalRecords,
} from "@/lib/missionControl.functions";

export const Route = createFileRoute("/_authenticated/readiness")({
  head: () => ({
    meta: [
      { title: "Mission Control — NeurlX" },
      { name: "description", content: "Production readiness score, deployment eligibility, audits, and governance for NeurlX." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MissionControl,
});

const TIER_COLOR: Record<string, string> = {
  not_ready: "text-destructive",
  paper_only: "text-warning",
  assisted_ready: "text-primary",
  autonomous_ready: "text-success",
  scale_ready: "text-success",
};

const CAT_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  trading: { icon: TrendingUp, label: "Trading" },
  ai: { icon: Brain, label: "AI Intelligence" },
  execution: { icon: Zap, label: "Execution" },
  risk: { icon: Shield, label: "Risk Health" },
  system: { icon: HeartPulse, label: "System" },
};

function MissionControl() {
  const qc = useQueryClient();
  const scoreFn = useServerFn(computeReadinessScore);
  const eligFn = useServerFn(evaluateDeploymentEligibility);

  const score = useQuery({
    queryKey: ["mc.score"],
    queryFn: () => scoreFn(),
    refetchInterval: 5 * 60_000,
  });
  const elig = useQuery({
    queryKey: ["mc.elig"],
    queryFn: () => eligFn(),
    refetchInterval: 5 * 60_000,
  });

  const recomputeMut = useMutation({
    mutationFn: () => scoreFn(),
    onSuccess: () => {
      toast.success("Readiness score recomputed");
      qc.invalidateQueries({ queryKey: ["mc.score"] });
      qc.invalidateQueries({ queryKey: ["mc.elig"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const overall = score.data?.overall ?? 0;
  const tier = score.data?.tier ?? "not_ready";
  const tone = TIER_COLOR[tier];

  return (
    <AppShell>
      <PageHeader
        title="Mission Control"
        subtitle="Production readiness audit & deployment governance. Evaluation-only — never bypasses risk controls."
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr] mb-4">
        <Card className="p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Overall NeurlX Health</div>
              <div className={`text-6xl font-bold ${tone}`}>{overall}</div>
              <div className={`text-sm font-medium ${tone} mt-1`}>{tier.replace(/_/g, " ").toUpperCase()}</div>
              {score.data && (
                <div className="text-xs text-muted-foreground mt-1">
                  Capital tier: <span className="font-medium">{score.data.capital_tier.replace(/_/g, " ")}</span>
                </div>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => recomputeMut.mutate()} disabled={recomputeMut.isPending}>
              <RefreshCw className={`w-4 h-4 mr-2 ${recomputeMut.isPending ? "animate-spin" : ""}`} />
              Recompute
            </Button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {Object.entries(score.data?.categoryScores ?? {}).map(([k, v]) => {
              const meta = CAT_META[k];
              const Icon = meta?.icon ?? Layers;
              return (
                <div key={k} className="rounded-md border border-border p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Icon className="w-3.5 h-3.5" />{meta?.label ?? k}
                  </div>
                  <div className="text-2xl font-semibold mt-1">{v as number}</div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-6">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-3">Blockers</div>
          {(score.data?.blockers.length ?? 0) === 0 ? (
            <div className="flex items-center gap-2 text-success">
              <ShieldCheck className="w-5 h-5" /> No blockers detected.
            </div>
          ) : (
            <ul className="space-y-2 text-sm">
              {score.data?.blockers.map((b, i) => (
                <li key={i} className="flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                  <span><span className="text-xs text-muted-foreground uppercase mr-2">{b.category}</span>{b.label}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Tabs defaultValue="eligibility" className="w-full">
        <TabsList className="w-full overflow-x-auto flex-nowrap justify-start">
          <TabsTrigger value="eligibility">Eligibility</TabsTrigger>
          <TabsTrigger value="capital">Capital</TabsTrigger>
          <TabsTrigger value="emergency">Emergency</TabsTrigger>
          <TabsTrigger value="audits">Audits</TabsTrigger>
          <TabsTrigger value="ai">AI Self-Review</TabsTrigger>
          <TabsTrigger value="checklist">Checklist</TabsTrigger>
          <TabsTrigger value="governance">Governance</TabsTrigger>
        </TabsList>

        <TabsContent value="eligibility"><EligibilityTab data={elig.data} /></TabsContent>
        <TabsContent value="capital"><CapitalTab /></TabsContent>
        <TabsContent value="emergency"><EmergencyTab /></TabsContent>
        <TabsContent value="audits"><AuditsTab /></TabsContent>
        <TabsContent value="ai"><AiTab /></TabsContent>
        <TabsContent value="checklist"><ChecklistTab /></TabsContent>
        <TabsContent value="governance"><GovernanceTab /></TabsContent>
      </Tabs>
    </AppShell>
  );
}

// ---------- Eligibility ----------
function EligibilityTab({ data }: { data: Awaited<ReturnType<typeof evaluateDeploymentEligibility>> | undefined }) {
  if (!data || data.needsScore) {
    return <Card className="p-4 text-sm text-muted-foreground">Run a readiness score first to unlock eligibility decisions.</Card>;
  }
  const chip = (s: string) =>
    s === "approved" ? <Badge className="bg-success/15 text-success border-success/30">Approved</Badge> :
    s === "conditional" ? <Badge className="bg-warning/15 text-warning border-warning/30">Conditional</Badge> :
    <Badge className="bg-destructive/15 text-destructive border-destructive/30">Not Ready</Badge>;
  return (
    <div className="space-y-3">
      {data.decisions.map((d, i) => (
        <Card key={i} className="p-4 flex items-start justify-between gap-4">
          <div>
            <div className="font-medium">{d.action}</div>
            <div className="text-xs text-muted-foreground mt-1">{d.reason}</div>
          </div>
          {chip(d.status)}
        </Card>
      ))}
      <div className="text-xs text-muted-foreground">Every decision is advisory. Nothing here changes automation state on its own.</div>
    </div>
  );
}

// ---------- Capital ----------
function CapitalTab() {
  const qc = useQueryClient();
  const genFn = useServerFn(generateCapitalScaleRecommendation);
  const listFn = useServerFn(listCapitalRecommendations);
  const decideFn = useServerFn(decideCapitalRecommendation);
  const list = useQuery({ queryKey: ["mc.cap"], queryFn: () => listFn() });
  const gen = useMutation({
    mutationFn: () => genFn(),
    onSuccess: () => { toast.success("Recommendation generated"); qc.invalidateQueries({ queryKey: ["mc.cap"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approved" | "rejected" }) => decideFn({ data: v }),
    onSuccess: () => { toast.success("Decision saved"); qc.invalidateQueries({ queryKey: ["mc.cap"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">Capital scaling requires manual approval.</div>
        <Button onClick={() => gen.mutate()} disabled={gen.isPending} size="sm">
          {gen.isPending ? "Analysing…" : "Generate recommendation"}
        </Button>
      </div>
      {(list.data ?? []).map(r => (
        <Card key={r.id} className="p-4">
          <div className="flex justify-between items-start">
            <div>
              <Badge variant="outline" className="mb-2 uppercase">{r.direction}</Badge>
              <div className="text-sm">
                <span className="text-muted-foreground">Current:</span>{" "}
                <span className="font-mono">${Number(r.current_allocation).toLocaleString()}</span>{" "}
                → <span className="font-mono font-semibold">${Number(r.suggested_allocation).toLocaleString()}</span>
              </div>
              <ul className="text-xs text-muted-foreground mt-2 space-y-1">
                {(r.reasons as string[]).map((x, i) => <li key={i}>• {x}</li>)}
              </ul>
            </div>
            <div className="text-right">
              <Badge variant={r.status === "pending" ? "secondary" : r.status === "approved" ? "default" : "destructive"}>
                {r.status}
              </Badge>
              {r.status === "pending" && (
                <div className="flex gap-2 mt-2">
                  <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, decision: "rejected" })}>Reject</Button>
                  <Button size="sm" onClick={() => decide.mutate({ id: r.id, decision: "approved" })}>Approve</Button>
                </div>
              )}
            </div>
          </div>
        </Card>
      ))}
      {(list.data ?? []).length === 0 && <Card className="p-4 text-sm text-muted-foreground">No recommendations yet.</Card>}
    </div>
  );
}

// ---------- Emergency ----------
function EmergencyTab() {
  const qc = useQueryClient();
  const runFn = useServerFn(runEmergencyChecks);
  const lastFn = useServerFn(getLastEmergencyCheck);
  const last = useQuery({ queryKey: ["mc.emg"], queryFn: () => lastFn() });
  const run = useMutation({
    mutationFn: () => runFn(),
    onSuccess: () => { toast.success("Emergency checks complete"); qc.invalidateQueries({ queryKey: ["mc.emg"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const results = (last.data?.results as Array<{ key: string; label: string; pass: boolean; detail: string }> | undefined) ?? [];
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">
          {last.data ? `Last run: passed ${last.data.passed} / failed ${last.data.failed}` : "No emergency checks run yet."}
        </div>
        <Button onClick={() => run.mutate()} disabled={run.isPending} size="sm">
          {run.isPending ? "Running…" : "Run checks now"}
        </Button>
      </div>
      <div className="grid gap-2">
        {results.map(c => (
          <Card key={c.key} className="p-3 flex items-start gap-3">
            {c.pass ? <CheckCircle2 className="w-5 h-5 text-success shrink-0 mt-0.5" /> : <XCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <div className="font-medium text-sm">{c.label}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{c.detail}</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------- Audits ----------
function AuditsTab() {
  const qc = useQueryClient();
  const genFn = useServerFn(generateAuditReport);
  const listFn = useServerFn(listAuditReports);
  const list = useQuery({ queryKey: ["mc.aud"], queryFn: () => listFn() });
  const gen = useMutation({
    mutationFn: (period: "daily" | "weekly" | "monthly") => genFn({ data: { period } }),
    onSuccess: () => { toast.success("Audit report generated"); qc.invalidateQueries({ queryKey: ["mc.aud"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={() => gen.mutate("daily")} disabled={gen.isPending}>Daily audit</Button>
        <Button size="sm" variant="outline" onClick={() => gen.mutate("weekly")} disabled={gen.isPending}>Weekly audit</Button>
        <Button size="sm" variant="outline" onClick={() => gen.mutate("monthly")} disabled={gen.isPending}>Monthly audit</Button>
      </div>
      {(list.data ?? []).map(r => (
        <Card key={r.id} className="p-4">
          <div className="flex justify-between items-center mb-2">
            <Badge variant="outline" className="uppercase">{r.period}</Badge>
            <div className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</div>
          </div>
          <pre className="text-xs whitespace-pre-wrap font-mono text-muted-foreground">{r.summary_md}</pre>
        </Card>
      ))}
      {(list.data ?? []).length === 0 && <Card className="p-4 text-sm text-muted-foreground">No audit reports yet.</Card>}
    </div>
  );
}

// ---------- AI Self-Review ----------
function AiTab() {
  const qc = useQueryClient();
  const genFn = useServerFn(generateAiSelfEvaluation);
  const listFn = useServerFn(listSelfEvaluations);
  const list = useQuery({ queryKey: ["mc.ai"], queryFn: () => listFn() });
  const gen = useMutation({
    mutationFn: () => genFn(),
    onSuccess: () => { toast.success("AI evaluation complete"); qc.invalidateQueries({ queryKey: ["mc.ai"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <div className="text-sm text-muted-foreground">Every recommendation is advisory and requires explicit approval.</div>
        <Button onClick={() => gen.mutate()} disabled={gen.isPending} size="sm">
          <Sparkles className="w-4 h-4 mr-2" /> {gen.isPending ? "Thinking…" : "Generate self-review"}
        </Button>
      </div>
      {(list.data ?? []).map(r => (
        <Card key={r.id} className="p-4">
          <div className="text-xs text-muted-foreground mb-2">{new Date(r.created_at).toLocaleString()}</div>
          <div className="text-sm whitespace-pre-wrap">{r.rationale}</div>
        </Card>
      ))}
      {(list.data ?? []).length === 0 && <Card className="p-4 text-sm text-muted-foreground">No self-reviews yet.</Card>}
    </div>
  );
}

// ---------- Checklist ----------
function ChecklistTab() {
  const qc = useQueryClient();
  const listFn = useServerFn(getProductionChecklist);
  const setFn = useServerFn(setChecklistItem);
  const list = useQuery({ queryKey: ["mc.chk"], queryFn: () => listFn() });
  const upd = useMutation({
    mutationFn: (v: { key: string; status: "pending" | "passed" | "failed" | "waived" }) => setFn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mc.chk"] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const badge = (s: string) => {
    if (s === "passed") return <Badge className="bg-success/15 text-success border-success/30">Passed</Badge>;
    if (s === "failed") return <Badge className="bg-destructive/15 text-destructive border-destructive/30">Failed</Badge>;
    if (s === "waived") return <Badge variant="secondary">Waived</Badge>;
    return <Badge variant="outline">Pending</Badge>;
  };
  return (
    <div className="space-y-2">
      {(list.data ?? []).map(item => (
        <Card key={item.key} className="p-3 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <ClipboardCheck className="w-4 h-4 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">{item.label}</div>
              {item.updated_at && <div className="text-xs text-muted-foreground">Updated {new Date(item.updated_at).toLocaleString()}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {badge(item.status)}
            <Button size="sm" variant="outline" onClick={() => upd.mutate({ key: item.key, status: "passed" })}>Pass</Button>
            <Button size="sm" variant="outline" onClick={() => upd.mutate({ key: item.key, status: "waived" })}>Waive</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------- Governance ----------
function GovernanceTab() {
  const qc = useQueryClient();
  const histFn = useServerFn(listDeploymentHistory);
  const snapListFn = useServerFn(listConfigurationSnapshots);
  const snapCapFn = useServerFn(captureConfigurationSnapshot);
  const ackListFn = useServerFn(listAcknowledgments);
  const ackFn = useServerFn(acknowledgeRisk);
  const approvalsFn = useServerFn(listApprovalRecords);

  const hist = useQuery({ queryKey: ["mc.hist"], queryFn: () => histFn() });
  const snaps = useQuery({ queryKey: ["mc.snap"], queryFn: () => snapListFn() });
  const acks = useQuery({ queryKey: ["mc.ack"], queryFn: () => ackListFn() });
  const approvals = useQuery({ queryKey: ["mc.appr"], queryFn: () => approvalsFn() });

  const [label, setLabel] = useState("");
  const [ackKind, setAckKind] = useState("live_trading");
  const [ackVersion, setAckVersion] = useState("v1");
  const [rationale, setRationale] = useState("");

  const cap = useMutation({
    mutationFn: () => snapCapFn({ data: { label: label || `Snapshot ${new Date().toLocaleString()}` } }),
    onSuccess: () => { toast.success("Snapshot captured"); setLabel(""); qc.invalidateQueries({ queryKey: ["mc.snap"] }); qc.invalidateQueries({ queryKey: ["mc.hist"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const ack = useMutation({
    mutationFn: () => ackFn({ data: { kind: ackKind, version: ackVersion } }),
    onSuccess: () => { toast.success("Acknowledgment recorded"); qc.invalidateQueries({ queryKey: ["mc.ack"] }); qc.invalidateQueries({ queryKey: ["mc.hist"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3"><Layers className="w-4 h-4" /><h3 className="font-medium">Configuration Snapshots</h3></div>
        <div className="flex gap-2 mb-3">
          <Input placeholder="Label (e.g. 'Pre-live cutover')" value={label} onChange={e => setLabel(e.target.value)} />
          <Button size="sm" onClick={() => cap.mutate()} disabled={cap.isPending}>Capture</Button>
        </div>
        <ul className="space-y-1 text-sm max-h-64 overflow-auto">
          {(snaps.data ?? []).map(s => (
            <li key={s.id} className="flex justify-between border-b border-border py-1">
              <span>{s.label}</span>
              <span className="text-xs text-muted-foreground">{new Date(s.created_at).toLocaleString()}</span>
            </li>
          ))}
          {(snaps.data ?? []).length === 0 && <li className="text-xs text-muted-foreground">No snapshots yet.</li>}
        </ul>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3"><ShieldCheck className="w-4 h-4" /><h3 className="font-medium">Risk Acknowledgments</h3></div>
        <div className="flex gap-2 mb-3">
          <Input placeholder="Kind" value={ackKind} onChange={e => setAckKind(e.target.value)} />
          <Input placeholder="Version" value={ackVersion} onChange={e => setAckVersion(e.target.value)} className="max-w-24" />
          <Button size="sm" onClick={() => ack.mutate()} disabled={ack.isPending}>Ack</Button>
        </div>
        <ul className="space-y-1 text-sm max-h-64 overflow-auto">
          {(acks.data ?? []).map(a => (
            <li key={a.id} className="flex justify-between border-b border-border py-1">
              <span>{a.kind} <span className="text-xs text-muted-foreground">v{a.version}</span></span>
              <span className="text-xs text-muted-foreground">{new Date(a.acknowledged_at).toLocaleString()}</span>
            </li>
          ))}
          {(acks.data ?? []).length === 0 && <li className="text-xs text-muted-foreground">No acknowledgments yet.</li>}
        </ul>
      </Card>

      <Card className="p-4 lg:col-span-2">
        <div className="flex items-center gap-2 mb-3"><HistoryIcon className="w-4 h-4" /><h3 className="font-medium">Deployment History</h3></div>
        <ul className="space-y-2 text-sm max-h-96 overflow-auto">
          {(hist.data ?? []).map(h => (
            <li key={h.id} className="flex justify-between border-b border-border pb-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><Badge variant="outline" className="text-xs">{h.change_type}</Badge><span className="text-xs text-muted-foreground">{h.actor}</span></div>
                <div className="mt-1">{h.summary}</div>
                {h.reason && <div className="text-xs text-muted-foreground mt-0.5">Reason: {h.reason}</div>}
              </div>
              <div className="text-xs text-muted-foreground shrink-0 ml-3">{new Date(h.created_at).toLocaleString()}</div>
            </li>
          ))}
          {(hist.data ?? []).length === 0 && <li className="text-xs text-muted-foreground">No deployment events yet.</li>}
        </ul>
      </Card>

      <Card className="p-4 lg:col-span-2">
        <div className="flex items-center gap-2 mb-3"><FileText className="w-4 h-4" /><h3 className="font-medium">Approval Records</h3></div>
        <ul className="space-y-2 text-sm max-h-72 overflow-auto">
          {(approvals.data ?? []).map(a => (
            <li key={a.id} className="border-b border-border pb-2">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">{a.kind}</Badge>
                <Badge variant={a.decision === "approved" ? "default" : a.decision === "rejected" ? "destructive" : "secondary"}>{a.decision}</Badge>
                <span className="text-xs text-muted-foreground ml-auto">{new Date(a.created_at).toLocaleString()}</span>
              </div>
              {a.rationale && <div className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{a.rationale}</div>}
            </li>
          ))}
          {(approvals.data ?? []).length === 0 && <li className="text-xs text-muted-foreground">No approvals recorded.</li>}
        </ul>
      </Card>

      <Card className="p-4 lg:col-span-2 border-warning/40 bg-warning/5">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-warning shrink-0 mt-0.5" />
          <div className="text-sm text-muted-foreground">
            <div className="font-medium text-foreground mb-1">Governance guarantee</div>
            This dashboard is evaluation and governance only. It never places, cancels, or modifies trades and cannot disable existing risk controls, circuit breakers, or the kill switch. All recommendations require explicit user approval to influence any other system.
            <Textarea className="mt-3" placeholder="Notes (optional)" value={rationale} onChange={e => setRationale(e.target.value)} />
          </div>
        </div>
      </Card>
    </div>
  );
}
