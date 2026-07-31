import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  getCorrelationMatrix, getPortfolioIntel, refreshPortfolioIntel, updatePortfolioIntelSettings,
} from "@/lib/portfolioIntel.functions";
import { SECTOR_LABELS, DEFAULT_SECTOR_LIMITS, type Sector } from "@/lib/portfolioIntel/sectors";
import { Brain, ShieldAlert, Zap } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/portfolio-intel")({
  head: () => ({
    meta: [
      { title: "Portfolio Intelligence — NeurlX" },
      { name: "description", content: "Portfolio Manager AI: health, exposure, correlation and capital allocation across every NeurlX strategy." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PortfolioIntel,
});

function Bar({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
  const good = invert ? value <= 50 : value >= 70;
  const mid = invert ? value <= 75 : value >= 50;
  const cls = good ? "bg-success" : mid ? "bg-warning" : "bg-destructive";
  return (
    <div>
      <div className="flex justify-between text-xs font-mono">
        <span className="text-muted-foreground uppercase">{label}</span>
        <span>{value.toFixed(1)}</span>
      </div>
      <div className="h-1.5 mt-1 rounded bg-muted overflow-hidden">
        <div className={`h-full ${cls}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
    </div>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const map: Record<string, { cls: string; icon: typeof Brain }> = {
    normal: { cls: "bg-primary/15 text-primary", icon: Brain },
    defensive: { cls: "bg-destructive/15 text-destructive", icon: ShieldAlert },
    aggressive: { cls: "bg-success/15 text-success", icon: Zap },
  };
  const it = map[mode] ?? map.normal;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase px-2 py-1 rounded ${it.cls}`}>
      <it.icon className="w-3 h-3" />{mode} mode
    </span>
  );
}

const GRADES = ["A+", "A", "B", "C", "D", "F"];

function PortfolioIntel() {
  const qc = useQueryClient();
  const intelFn = useServerFn(getPortfolioIntel);
  const matrixFn = useServerFn(getCorrelationMatrix);
  const refreshFn = useServerFn(refreshPortfolioIntel);
  const saveFn = useServerFn(updatePortfolioIntelSettings);

  const { data } = useQuery({ queryKey: ["portfolio-intel"], queryFn: () => intelFn() });
  const { data: corr } = useQuery({ queryKey: ["portfolio-corr"], queryFn: () => matrixFn() });
  const [minScore, setMinScore] = useState<number | null>(null);
  const [beta, setBeta] = useState<number | null>(null);

  const refresh = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: r => {
      toast.success(`Health ${r.healthScore} · ${r.mode} mode · ${r.graded} trades graded`);
      qc.invalidateQueries({ queryKey: ["portfolio-intel"] });
      qc.invalidateQueries({ queryKey: ["portfolio-corr"] });
    },
    onError: e => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof saveFn>[0]["data"]) => saveFn({ data: patch }),
    onSuccess: () => { toast.success("Saved"); qc.invalidateQueries({ queryKey: ["portfolio-intel"] }); },
    onError: e => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const s = data?.snapshot;
  const settings = data?.settings;
  const totalGrades = Object.values(data?.gradeCounts ?? {}).reduce((a, b) => a + b, 0);
  const maxSector = Math.max(1, ...Object.values(s?.sectorExposure ?? {}));

  return (
    <AppShell>
      <PageHeader
        title="Portfolio Intelligence"
        subtitle="The Portfolio Manager AI sits above every strategy and above the Risk Engine. Nothing reaches a broker without a score, an allocation and a health check."
      />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <ModeBadge mode={s?.mode ?? "normal"} />
        <span className="text-xs font-mono text-muted-foreground">
          Pipeline: Strategy → Lifecycle → Portfolio Manager → Risk Engine → Execution → Broker
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? "Recomputing…" : "Recompute now"}
        </Button>
      </div>

      <div className="grid lg:grid-cols-[1.2fr,1fr] gap-6">
        <div className="panel p-6">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Portfolio health</h2>
            <div className="text-3xl font-mono">{s?.healthScore?.toFixed(1) ?? "—"}<span className="text-sm text-muted-foreground">/100</span></div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 mt-5">
            <Bar label="Heat" value={s?.health.heat ?? 0} invert />
            <Bar label="Risk concentration" value={s?.health.riskConcentration ?? 0} invert />
            <Bar label="Capital utilization" value={s?.health.capitalUtilization ?? 0} invert />
            <Bar label="Correlation score" value={s?.health.correlationScore ?? 0} />
            <Bar label="Volatility" value={s?.health.volatility ?? 0} invert />
            <Bar label="Diversification" value={s?.health.diversificationScore ?? 0} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6 text-sm font-mono">
            <div><div className="text-[10px] uppercase text-muted-foreground">Equity</div>{fmtUsd(s?.equity ?? 0)}</div>
            <div><div className="text-[10px] uppercase text-muted-foreground">Drawdown</div>{(s?.drawdownPct ?? 0).toFixed(2)}%</div>
            <div><div className="text-[10px] uppercase text-muted-foreground">Exp. monthly</div>{(s?.expectedMonthlyReturn ?? 0).toFixed(2)}%</div>
            <div className="text-destructive"><div className="text-[10px] uppercase text-muted-foreground">Worst case</div>{(s?.worstCaseProjection ?? 0).toFixed(2)}%</div>
          </div>
          {s?.notes?.length ? (
            <ul className="mt-4 space-y-1 text-xs text-muted-foreground list-disc pl-4">
              {s.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          ) : null}
        </div>

        <div className="panel p-6 space-y-4">
          <h2 className="font-semibold">Manager controls</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Minimum score</Label>
              <Input type="number" value={minScore ?? settings?.pmMinScore ?? 75}
                onChange={e => setMinScore(+e.target.value)}
                onBlur={e => save.mutate({ pmMinScore: +e.target.value })} />
            </div>
            <div>
              <Label>Max crypto beta (%)</Label>
              <Input type="number" value={beta ?? settings?.maxCryptoBeta ?? 6}
                onChange={e => setBeta(+e.target.value)}
                onBlur={e => save.mutate({ maxCryptoBeta: +e.target.value })} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings?.pmEnabled ?? true}
              onChange={e => save.mutate({ pmEnabled: e.target.checked })} />
            Portfolio Manager gate active
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings?.aggressiveEnabled ?? true}
              onChange={e => save.mutate({ aggressiveEnabled: e.target.checked })} />
            Allow aggressive mode (health &gt; 95, drawdown &lt; 2%)
          </label>
          <div className="pt-3 border-t border-border text-xs font-mono space-y-1 text-muted-foreground">
            <div>Score ladder: 95+ → 100% · 90 → 80% · 85 → 60% · 80 → 40% · 75 → 20% · below → reject</div>
            <div>Overtrading: {settings?.overtradingMax ?? 3} trades / {settings?.overtradingWindow ?? 30}m then score ≥ {settings?.overtradingMinScore ?? 95}</div>
            <div>Current gate: score ≥ {s?.constraints.minScore ?? 75}, confidence ≥ {((s?.constraints.minConfidence ?? 0.9) * 100).toFixed(0)}%, size ×{(s?.constraints.sizeMultiplier ?? 1).toFixed(2)}</div>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <div className="panel p-6">
          <h2 className="font-semibold mb-4">Sector exposure</h2>
          {Object.keys(s?.sectorExposure ?? {}).length === 0 && <p className="text-sm text-muted-foreground">No open exposure.</p>}
          <div className="space-y-3">
            {Object.entries(s?.sectorExposure ?? {}).map(([sec, pct]) => {
              const limit = settings?.sectorLimits?.[sec] ?? DEFAULT_SECTOR_LIMITS[sec as Sector] ?? 20;
              const over = pct > limit;
              return (
                <div key={sec}>
                  <div className="flex justify-between text-xs font-mono">
                    <span>{SECTOR_LABELS[sec as Sector] ?? sec}</span>
                    <span className={over ? "text-destructive" : ""}>{pct.toFixed(1)}% / {limit}%</span>
                  </div>
                  <div className="h-1.5 mt-1 rounded bg-muted overflow-hidden">
                    <div className={`h-full ${over ? "bg-destructive" : "bg-primary"}`}
                      style={{ width: `${Math.min(100, (pct / maxSector) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="panel p-6 overflow-x-auto">
          <h2 className="font-semibold mb-4">Correlation matrix</h2>
          {(corr?.symbols.length ?? 0) < 2 ? (
            <p className="text-sm text-muted-foreground">Needs at least two open positions.</p>
          ) : (
            <table className="text-[11px] font-mono">
              <thead><tr><th /> {corr!.symbols.map(sy => <th key={sy} className="px-2 py-1 text-muted-foreground">{sy}</th>)}</tr></thead>
              <tbody>
                {corr!.matrix.map((row, i) => (
                  <tr key={i}>
                    <td className="pr-2 text-muted-foreground">{corr!.symbols[i]}</td>
                    {row.map((v, j) => (
                      <td key={j} className="px-2 py-1 text-center rounded"
                        style={{ background: `rgba(239,68,68,${Math.max(0, v - 0.4)})` }}>{v.toFixed(2)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <div className="panel p-6">
          <h2 className="font-semibold mb-4">Live heat map — open risk</h2>
          {s?.open.length ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {s.open.map(p => (
                <div key={p.symbol + p.side} className="rounded-md p-3 border border-border"
                  style={{ background: `rgba(239,68,68,${Math.min(0.5, p.riskPct / 4)})` }}>
                  <div className="text-sm font-medium">{p.symbol}</div>
                  <div className="text-[10px] font-mono uppercase text-muted-foreground">{p.side} · {p.riskPct.toFixed(2)}% risk</div>
                  <div className="text-xs font-mono">{fmtUsd(p.notional)}</div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">Flat — no open positions.</p>}
        </div>

        <div className="panel p-6">
          <h2 className="font-semibold mb-4">Trade quality distribution</h2>
          {totalGrades === 0 ? <p className="text-sm text-muted-foreground">No graded trades yet.</p> : (
            <div className="space-y-2">
              {GRADES.map(g => {
                const n = data?.gradeCounts[g] ?? 0;
                return (
                  <div key={g} className="flex items-center gap-3 text-xs font-mono">
                    <span className="w-6">{g}</span>
                    <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${(n / totalGrades) * 100}%` }} />
                    </div>
                    <span className="w-8 text-right">{n}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mt-6">
        <div className="panel p-6">
          <h2 className="font-semibold mb-4">Current regime</h2>
          {data?.regimes.length ? (
            <div className="space-y-2 text-sm">
              {data.regimes.slice(0, 8).map((r, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="font-mono">{r.symbol}</span>
                  <span className={r.tradable ? "" : "text-destructive"}>{r.label}</span>
                  <span className="text-xs font-mono text-muted-foreground">{(r.confidence * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">Run “Recompute now” to classify the market.</p>}
        </div>

        <div className="panel p-6">
          <h2 className="font-semibold mb-4">Strategy contributions</h2>
          {data?.strategyContributions.length ? (
            <div className="space-y-2 text-sm">
              {data.strategyContributions.slice(0, 8).map(c => (
                <div key={c.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{c.name} <span className="text-[10px] font-mono uppercase text-muted-foreground">{c.state}</span></span>
                  <span className={`font-mono ${c.pnl >= 0 ? "text-success" : "text-destructive"}`}>{fmtUsd(c.pnl)}</span>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">No closed trades attributed yet.</p>}
        </div>
      </div>

      <div className="panel p-6 mt-6">
        <h2 className="font-semibold mb-4">Capital allocation decisions</h2>
        {data?.decisions.length ? (
          <div className="space-y-2">
            {data.decisions.slice(0, 25).map(d => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {d.symbol} <span className="text-[10px] font-mono uppercase text-muted-foreground">{d.side} · {d.regime ?? "—"} · {d.mode}</span>
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {d.approved ? d.notes[d.notes.length - 1] ?? "Approved" : d.rejectReason}
                  </div>
                </div>
                <div className="flex gap-5 text-xs font-mono">
                  <div><span className="text-muted-foreground">SCORE </span>{d.score.toFixed(1)}</div>
                  <div><span className="text-muted-foreground">ALLOC </span>{d.allocation.toFixed(0)}%</div>
                  <div><span className="text-muted-foreground">RISK </span>{d.riskPct.toFixed(2)}%</div>
                  <div className={d.approved ? "text-success" : "text-destructive"}>{d.approved ? "APPROVED" : "REJECTED"}</div>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">The Portfolio Manager has not scored any opportunity yet.</p>}
      </div>

      <div className="panel p-6 mt-6">
        <h2 className="font-semibold mb-4">Self-learning capital engine</h2>
        {data?.capitalProposals.length ? (
          <div className="space-y-2 text-xs font-mono">
            {data.capitalProposals.map(p => (
              <div key={p.id} className="flex flex-wrap gap-4 justify-between rounded-md border border-border p-3">
                <span>v{p.version} · {p.status} · {new Date(p.at).toLocaleDateString()}</span>
                <span>ALLOC {p.allocationPct.toFixed(2)}%</span>
                <span>STOP {p.stopAtrMult.toFixed(2)}×ATR</span>
                <span>TP {p.tpRMultiple.toFixed(2)}R</span>
                <span>HOLD {p.holdingMinutes}m</span>
                <span>TRAIL {(p.trailingPct * 100).toFixed(2)}%</span>
                <span className="text-muted-foreground">exp {(p.metrics.expectancyR ?? 0).toFixed(2)}R</span>
              </div>
            ))}
          </div>
        ) : <p className="text-sm text-muted-foreground">Recalculates after every 100 closed trades. Proposals stay in shadow until validated.</p>}
      </div>
    </AppShell>
  );
}
