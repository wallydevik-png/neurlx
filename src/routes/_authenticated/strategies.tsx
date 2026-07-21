import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import { listStrategiesWithHealth, updateStrategy, evaluateStrategyHealthFn } from "@/lib/portfolio.functions";
import { toast } from "sonner";
import { Activity, AlertTriangle, CheckCircle2, PauseCircle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/strategies")({
  head: () => ({ meta: [{ title: "Strategies — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: StrategiesPage,
});

const TYPES = [
  { id: "trend_following", label: "Trend following" },
  { id: "momentum", label: "Momentum" },
  { id: "breakout", label: "Breakout" },
  { id: "mean_reversion", label: "Mean reversion" },
  { id: "volatility", label: "Volatility" },
] as const;

function HealthPill({ status }: { status: string }) {
  const m: Record<string, { cls: string; icon: typeof Activity; label: string }> = {
    healthy:              { cls: "bg-success/15 text-success", icon: CheckCircle2, label: "Healthy" },
    watch:                { cls: "bg-warning/15 text-warning", icon: Activity, label: "Watch" },
    underperforming:      { cls: "bg-warning/15 text-warning", icon: AlertTriangle, label: "Underperforming" },
    consider_disabling:   { cls: "bg-destructive/15 text-destructive", icon: PauseCircle, label: "Consider disabling" },
    unmonitored:          { cls: "bg-muted text-muted-foreground", icon: Activity, label: "Unmonitored" },
  };
  const it = m[status] ?? m.unmonitored;
  return <span className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase px-2 py-0.5 rounded ${it.cls}`}><it.icon className="w-3 h-3" />{it.label}</span>;
}

function StrategiesPage() {
  const listFn = useServerFn(listStrategiesWithHealth);
  const updFn = useServerFn(updateStrategy);
  const evalFn = useServerFn(evaluateStrategyHealthFn);
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["strategies-health"], queryFn: () => listFn() });

  async function mut(id: string, patch: { isActive?: boolean; strategyType?: "trend_following" | "momentum" | "breakout" | "mean_reversion" | "volatility"; capitalAllocationPct?: number }) {
    try { await updFn({ data: { id, ...patch } }); qc.invalidateQueries({ queryKey: ["strategies-health"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function evaluate(id: string) {
    try { const r = await evalFn({ data: { id } }); toast.success(`Health: ${r.status.replace("_", " ")}`); qc.invalidateQueries({ queryKey: ["strategies-health"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  const totalAllocation = data.reduce((s, r) => s + (r.is_active ? Number(r.capital_allocation_pct ?? 0) : 0), 0);

  return (
    <AppShell>
      <PageHeader title="Multi-strategy system" subtitle="Run strategies in parallel, allocate capital, and monitor performance health." />

      <div className="panel p-4 mb-4 flex items-center justify-between text-sm">
        <div>Active capital allocation: <span className="font-mono">{totalAllocation.toFixed(1)}%</span> {totalAllocation > 100 && <span className="text-destructive ml-2">Over-allocated</span>}</div>
        <div className="text-xs text-muted-foreground">{data.filter(d => d.is_active).length} of {data.length} active</div>
      </div>

      {data.length === 0 ? (
        <div className="panel p-8 text-sm text-muted-foreground">Save a strategy from the Strategy Lab to start tracking it here.</div>
      ) : (
        <div className="space-y-3">
          {data.map(s => (
            <div key={s.id} className="panel p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold">{s.name}</h3>
                    <HealthPill status={s.health_status ?? "unmonitored"} />
                    <span className="text-[10px] font-mono uppercase text-muted-foreground">{s.symbol} · {s.interval}</span>
                  </div>
                  {s.health_notes && <p className="mt-1 text-xs text-muted-foreground">{s.health_notes}</p>}
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-mono uppercase">
                  <input type="checkbox" checked={!!s.is_active} onChange={e => mut(s.id, { isActive: e.target.checked })} />
                  Active
                </label>
              </div>
              <div className="mt-4 grid md:grid-cols-3 gap-3 text-sm">
                <div>
                  <label className="text-[10px] font-mono uppercase text-muted-foreground">Type</label>
                  <select value={s.strategy_type ?? "trend_following"} onChange={e => mut(s.id, { strategyType: e.target.value as "trend_following" | "momentum" | "breakout" | "mean_reversion" | "volatility" })}
                    className="mt-1 w-full rounded-md bg-input border border-border px-2 py-1.5 text-sm">
                    {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-mono uppercase text-muted-foreground">Capital allocation %</label>
                  <input type="number" min={0} max={100} step={1} defaultValue={Number(s.capital_allocation_pct ?? 0)}
                    onBlur={e => mut(s.id, { capitalAllocationPct: Number(e.target.value) })}
                    className="mt-1 w-full rounded-md bg-input border border-border px-2 py-1.5 text-sm font-mono" />
                </div>
                <div className="flex items-end">
                  <button onClick={() => evaluate(s.id)} className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase w-full">Evaluate health</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
