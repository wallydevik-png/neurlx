import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import { toast } from "sonner";
import { useState } from "react";
import {
  listStrategyLifecycle, evaluateLifecycleFn, setStrategyState,
  compareStrategiesFn, retrainModelsFn,
} from "@/lib/lifecycle.functions";
import { AlertTriangle, Activity, ShieldCheck, EyeOff, Ban, GitCompare } from "lucide-react";

export const Route = createFileRoute("/_authenticated/strategy-lifecycle")({
  head: () => ({
    meta: [
      { title: "Strategy Lifecycle — NeurlX" },
      { name: "description", content: "Shadow, paper and live strategy validation with automatic promotion, demotion and drift detection." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LifecyclePage,
});

const STATE_STYLE: Record<string, { cls: string; icon: typeof Activity; label: string }> = {
  live: { cls: "bg-success/15 text-success", icon: ShieldCheck, label: "LIVE" },
  paper: { cls: "bg-primary/15 text-primary", icon: Activity, label: "PAPER" },
  shadow: { cls: "bg-muted text-muted-foreground", icon: EyeOff, label: "SHADOW" },
  disabled: { cls: "bg-destructive/15 text-destructive", icon: Ban, label: "DISABLED" },
};

type Metrics = {
  trades: number; winRate: number; profitFactor: number; expectancy: number;
  avgR: number; sharpe: number; sortino: number; maxDrawdown: number;
  netPnl: number; executionQuality: number;
};
type RunRow = {
  strategy_id: string; score: number; state: string;
  windows: { w20?: Metrics; w50?: Metrics; w100?: Metrics; w300?: Metrics } | null;
  walk_forward: { passRate?: number; latest?: { validationProfitFactor?: number; degradation?: number } | null } | null;
  drift: { detected?: boolean; reasons?: string[] } | null;
  eligibility: { promotionChecks?: { label: string; passed: boolean; detail: string }[]; demotionWarnings?: string[]; allocation?: number } | null;
};

const pct = (v: number | undefined) => `${((v ?? 0) * 100).toFixed(1)}%`;
const n2 = (v: number | undefined) => (Number(v ?? 0)).toFixed(2);

function MiniWindow({ label, m }: { label: string; m?: Metrics }) {
  if (!m || m.trades === 0) return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] font-mono uppercase text-muted-foreground">{label}</div>
      <div className="text-xs text-muted-foreground mt-1">No trades</div>
    </div>
  );
  return (
    <div className="rounded-md border border-border p-2">
      <div className="text-[10px] font-mono uppercase text-muted-foreground">{label} · {m.trades}t</div>
      <div className="mt-1 grid grid-cols-2 gap-x-2 text-[11px] font-mono">
        <span className="text-muted-foreground">PF</span><span>{n2(m.profitFactor)}</span>
        <span className="text-muted-foreground">WIN</span><span>{pct(m.winRate)}</span>
        <span className="text-muted-foreground">SHRP</span><span>{n2(m.sharpe)}</span>
        <span className="text-muted-foreground">DD</span><span className="text-destructive">{pct(m.maxDrawdown)}</span>
        <span className="text-muted-foreground">EXP</span><span className={m.expectancy >= 0 ? "text-success" : "text-destructive"}>{n2(m.expectancy)}</span>
      </div>
    </div>
  );
}

function LifecyclePage() {
  const listFn = useServerFn(listStrategyLifecycle);
  const evalFn = useServerFn(evaluateLifecycleFn);
  const stateFn = useServerFn(setStrategyState);
  const cmpFn = useServerFn(compareStrategiesFn);
  const retrainFn = useServerFn(retrainModelsFn);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["lifecycle"], queryFn: () => listFn(), refetchInterval: 60_000 });

  const [champion, setChampion] = useState("");
  const [challenger, setChallenger] = useState("");
  const [cmp, setCmp] = useState<Awaited<ReturnType<typeof cmpFn>> | null>(null);

  const strategies = data?.strategies ?? [];
  const runs = (data?.runs ?? []) as unknown as RunRow[];
  const runFor = (id: string) => runs.find(r => r.strategy_id === id);
  const regimes = data?.regimes ?? [];

  async function run<T>(p: Promise<T>, ok: (r: T) => string) {
    try { const r = await p; toast.success(ok(r)); qc.invalidateQueries({ queryKey: ["lifecycle"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  const liveCount = strategies.filter(s => s.lifecycle_state === "live").length;
  const totalAlloc = strategies.reduce((a, s) => a + Number(s.allocation_risk_pct ?? 0), 0);

  return (
    <AppShell>
      <PageHeader
        title="Strategy Lifecycle"
        subtitle="Every strategy must continuously earn the right to trade real money. Shadow → Paper → Live, with automatic demotion when performance decays."
        action={<div className="flex gap-2">
          <button onClick={() => run(retrainFn({ data: { force: true } }), r => r.ran ? `Retrained — ${r.version}` : "Retraining not due yet")}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase">Retrain now</button>
          <button onClick={() => run(evalFn(), r => `Evaluated ${r.evaluated} · ${r.changed.length} state change${r.changed.length === 1 ? "" : "s"}`)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-mono uppercase text-primary-foreground">Run validation</button>
        </div>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Strategies" value={String(strategies.length)} />
        <Metric label="Live-approved" value={String(liveCount)} sub="score ≥ 80" />
        <Metric label="Allocated risk" value={`${totalAlloc.toFixed(2)}%`} />
        <Metric label="Drifting" value={String(strategies.filter(s => s.drift_detected).length)} tone={strategies.some(s => s.drift_detected) ? "neg" : undefined} />
      </div>

      {strategies.length === 0 && (
        <div className="panel p-8 mt-4 text-sm text-muted-foreground">
          No strategies registered. Save one from the Strategy Lab — it starts in SHADOW and must pass validation before it can trade real money.
        </div>
      )}

      <div className="space-y-4 mt-4">
        {strategies.map(s => {
          const r = runFor(s.id);
          const st = STATE_STYLE[String(s.lifecycle_state)] ?? STATE_STYLE.shadow;
          const checks = r?.eligibility?.promotionChecks ?? [];
          const warnings = r?.eligibility?.demotionWarnings ?? [];
          const sRegimes = regimes.filter(g => g.strategy_id === s.id);
          return (
            <div key={s.id} className="panel p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{s.name}</h3>
                    <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase px-2 py-0.5 rounded ${st.cls}`}>
                      <st.icon className="w-3 h-3" />{st.label}
                    </span>
                    <span className="text-[10px] font-mono uppercase text-muted-foreground">{s.symbol} · {s.interval}</span>
                    {s.drift_detected && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-warning/15 text-warning">
                        <AlertTriangle className="w-3 h-3" />Drift · allocation halved
                      </span>
                    )}
                  </div>
                  {s.state_reason && <p className="mt-1 text-xs text-muted-foreground">{s.state_reason}</p>}
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <div className="text-[10px] font-mono uppercase text-muted-foreground">Score</div>
                    <div className={`text-xl font-mono ${Number(s.score) >= 80 ? "text-success" : Number(s.score) >= 65 ? "text-primary" : Number(s.score) >= 50 ? "" : "text-destructive"}`}>
                      {Number(s.score).toFixed(0)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-mono uppercase text-muted-foreground">Risk alloc.</div>
                    <div className="text-xl font-mono">{Number(s.allocation_risk_pct ?? 0).toFixed(2)}%</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
                <MiniWindow label="Last 20" m={r?.windows?.w20} />
                <MiniWindow label="Last 50" m={r?.windows?.w50} />
                <MiniWindow label="Last 100" m={r?.windows?.w100} />
                <MiniWindow label="Last 300" m={r?.windows?.w300} />
              </div>

              <div className="mt-3 grid md:grid-cols-3 gap-3 text-xs">
                <div className="rounded-md border border-border p-3">
                  <div className="font-mono uppercase text-[10px] text-muted-foreground mb-1">Walk-forward</div>
                  <div>Pass rate <span className="font-mono">{pct(r?.walk_forward?.passRate)}</span></div>
                  <div>Latest validation PF <span className="font-mono">{n2(r?.walk_forward?.latest?.validationProfitFactor)}</span></div>
                  <div>Degradation <span className="font-mono">{pct(r?.walk_forward?.latest?.degradation)}</span></div>
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="font-mono uppercase text-[10px] text-muted-foreground mb-1">Regime performance</div>
                  {sRegimes.length === 0 ? <div className="text-muted-foreground">No regime data yet.</div> : sRegimes.map(g => (
                    <div key={g.id} className="flex justify-between">
                      <span className="capitalize">{String(g.regime).replace("_", " ")}</span>
                      <span className={`font-mono ${Number(g.profit_factor) >= 1.4 ? "text-success" : "text-muted-foreground"}`}>
                        PF {Number(g.profit_factor).toFixed(2)} · {g.trades}t
                      </span>
                    </div>
                  ))}
                </div>
                <div className="rounded-md border border-border p-3">
                  <div className="font-mono uppercase text-[10px] text-muted-foreground mb-1">Shadow vs live</div>
                  <div>Shadow PF <span className="font-mono">{n2(r?.windows?.w300?.profitFactor)}</span></div>
                  <div>Execution quality <span className="font-mono">{pct(r?.windows?.w50?.executionQuality)}</span></div>
                  <div>Avg R <span className="font-mono">{n2(r?.windows?.w50?.avgR)}</span></div>
                </div>
              </div>

              {checks.length > 0 && (
                <div className="mt-3">
                  <div className="font-mono uppercase text-[10px] text-muted-foreground mb-1">Promotion eligibility</div>
                  <div className="flex flex-wrap gap-1.5">
                    {checks.map(c => (
                      <span key={c.label} className={`text-[10px] font-mono px-2 py-0.5 rounded ${c.passed ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
                        {c.passed ? "✓" : "✗"} {c.label} ({c.detail})
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {warnings.length > 0 && (
                <div className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">
                  <strong className="font-mono uppercase text-[10px]">Demotion warnings</strong>
                  <ul className="mt-1 list-disc pl-4">{warnings.map(w => <li key={w}>{w}</li>)}</ul>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                {(["shadow", "paper", "live", "disabled"] as const).map(target => (
                  <button key={target} disabled={s.lifecycle_state === target}
                    onClick={() => run(stateFn({ data: { id: s.id, state: target, reason: "manual_override" } }), () => `Moved to ${target.toUpperCase()}`)}
                    className="rounded-md border border-border px-2.5 py-1 text-[10px] font-mono uppercase disabled:opacity-40">
                    Set {target}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {strategies.length >= 2 && (
        <div className="panel p-5 mt-6">
          <div className="flex items-center gap-2 mb-3">
            <GitCompare className="w-4 h-4 text-primary" />
            <h2 className="font-semibold">A/B candidate comparison</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-3 text-sm">
            <select value={champion} onChange={e => setChampion(e.target.value)} className="rounded-md bg-input border border-border px-2 py-1.5">
              <option value="">Champion (current)</option>
              {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={challenger} onChange={e => setChallenger(e.target.value)} className="rounded-md bg-input border border-border px-2 py-1.5">
              <option value="">Challenger (candidate)</option>
              {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button disabled={!champion || !challenger || champion === challenger}
              onClick={async () => {
                try { setCmp(await cmpFn({ data: { championId: champion, challengerId: challenger } })); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-mono uppercase text-primary-foreground disabled:opacity-40">Compare</button>
          </div>
          {cmp && (
            <div className="mt-3 text-xs font-mono grid md:grid-cols-3 gap-3">
              <div className="rounded-md border border-border p-3">Champion score {cmp.champion.score} · PF {n2(cmp.champion.metrics.profitFactor)}</div>
              <div className="rounded-md border border-border p-3">Challenger score {cmp.challenger.score} · PF {n2(cmp.challenger.metrics.profitFactor)}</div>
              <div className={`rounded-md border p-3 ${cmp.verdict === "promote_challenger" ? "border-success/50 text-success" : "border-border"}`}>
                {(cmp.significance.probability * 100).toFixed(1)}% confidence · {cmp.verdict.replace("_", " ")}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="panel p-5 mt-6">
        <h2 className="font-semibold mb-3">Lifecycle history</h2>
        {(data?.events ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No promotions or demotions yet.</p>
        ) : (
          <div className="space-y-1 text-xs font-mono">
            {(data?.events ?? []).map(e => (
              <div key={e.id} className="flex justify-between gap-4 border-b border-border/50 py-1">
                <span className="uppercase">{e.from_state} → {e.to_state}</span>
                <span className="text-muted-foreground truncate flex-1">{e.reason}</span>
                <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel p-5 mt-6">
        <h2 className="font-semibold mb-3">Model versions</h2>
        {(data?.models ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No trained candidates yet. Retraining runs each weekend and always deploys to SHADOW first.</p>
        ) : (
          <div className="space-y-1 text-xs font-mono">
            {(data?.models ?? []).map(m => (
              <div key={m.id} className="flex justify-between gap-4 border-b border-border/50 py-1">
                <span>{m.version}</span>
                <span className="uppercase text-muted-foreground">{m.state}</span>
                <span className="text-muted-foreground">{new Date(m.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
