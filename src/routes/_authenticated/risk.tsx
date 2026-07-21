import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import {
  getRiskDashboard, getAdvancedRiskSettings, saveAdvancedRiskSettings, suggestPositionSize,
} from "@/lib/risk.functions";

type PortfolioRiskReport = {
  equity: number; openPositions: number; portfolioHeatPct: number;
  perAssetRiskPct: { symbol: string; pct: number }[];
  var95Pct: number; cvar95Pct: number; portfolioVolPct: number;
  correlationMax: number; correlationPairs: { a: string; b: string; corr: number }[];
  riskScore: number; advisories: string[];
};
import { Shield, AlertTriangle, Calculator, TrendingUp } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/risk")({
  head: () => ({ meta: [
    { title: "Advanced Risk — NeurlX" },
    { name: "description", content: "Portfolio VaR/CVaR, correlation caps, heat, and dynamic position sizing." },
    { name: "robots", content: "noindex" },
  ]}),
  component: RiskPage,
});

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div className="flex justify-between text-xs font-mono py-1.5 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className={danger ? "text-destructive font-semibold" : "text-foreground"}>{v}</span>
    </div>
  );
}

function RiskPage() {
  const qc = useQueryClient();
  const fetchDash = useServerFn(getRiskDashboard);
  const fetchSettings = useServerFn(getAdvancedRiskSettings);
  const saveSettings = useServerFn(saveAdvancedRiskSettings);
  const suggest = useServerFn(suggestPositionSize);

  const dash = useQuery({ queryKey: ["risk-dash"], queryFn: () => fetchDash(), refetchInterval: 60000 });
  const settings = useQuery({ queryKey: ["risk-settings"], queryFn: () => fetchSettings() });

  const [form, setForm] = useState<Record<string, number> | null>(null);
  const current = form ?? (settings.data ? {
    max_portfolio_heat_pct: Number(settings.data.max_portfolio_heat_pct),
    max_correlation: Number(settings.data.max_correlation),
    max_var_pct: Number(settings.data.max_var_pct),
    target_daily_vol_pct: Number(settings.data.target_daily_vol_pct),
    kelly_fraction: Number(settings.data.kelly_fraction),
    max_sector_pct: Number(settings.data.max_sector_pct),
  } : null);

  const saveMut = useMutation({
    mutationFn: (d: Record<string, number>) => saveSettings({ data: d }),
    onSuccess: () => { toast.success("Risk settings saved"); qc.invalidateQueries({ queryKey: ["risk-dash"] }); qc.invalidateQueries({ queryKey: ["risk-settings"] }); setForm(null); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [sizer, setSizer] = useState({ symbol: "BTC-USD", entry: 60000, stopLoss: 58000, confidence: 0.65 });
  const sizeMut = useMutation({
    mutationFn: () => suggest({ data: sizer }),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const r = dash.data?.report as PortfolioRiskReport | undefined;
  const scoreColor = useMemo(() => {
    const s = r?.riskScore ?? 0;
    if (s > 70) return "text-destructive";
    if (s > 40) return "text-warning";
    return "text-success";
  }, [r?.riskScore]);

  return (
    <AppShell>
      <PageHeader
        title="Advanced Risk"
        subtitle="Portfolio-level VaR/CVaR, correlation caps, heat, and dynamic position sizing."
        action={<button onClick={() => dash.refetch()} disabled={dash.isFetching}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase">
          {dash.isFetching ? "Recomputing…" : "Recompute"}
        </button>}
      />

      {dash.isLoading || !r ? (
        <div className="text-muted-foreground text-sm">Computing portfolio risk…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Equity" value={fmtUsd(r.equity)} sub={`${r.openPositions} open`} />
            <Metric label="Portfolio Heat" value={fmtPct(r.portfolioHeatPct / 100)} sub="Open risk / equity" />
            <Metric label="Daily VaR 95%" value={fmtPct(r.var95Pct / 100)} sub={`CVaR ${fmtPct(r.cvar95Pct/100)}`} />
            <Metric label="Risk Score" value={String(r.riskScore)} sub={`Vol ${fmtPct(r.portfolioVolPct/100)}`} tone={r.riskScore > 70 ? "neg" : r.riskScore < 30 ? "pos" : undefined} />
{void scoreColor}
          </div>

          {(dash.data?.breaches?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
              <div className="flex items-center gap-2 text-destructive text-xs font-mono uppercase mb-1">
                <AlertTriangle className="w-4 h-4" /> Cap Breaches
              </div>
              <ul className="text-xs space-y-0.5">
                {(dash.data!.breaches as string[]).map((b: string, i: number) => <li key={i}>• {b}</li>)}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3"><Shield className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">Per-Asset Open Risk</h3></div>
              {r.perAssetRiskPct.length === 0 ? (
                <div className="text-xs text-muted-foreground">No open positions.</div>
              ) : (
                <div className="space-y-2">
                  {r.perAssetRiskPct.map(a => (
                    <div key={a.symbol}>
                      <div className="flex justify-between text-xs font-mono">
                        <span>{a.symbol}</span><span>{a.pct.toFixed(2)}%</span>
                      </div>
                      <div className="h-1.5 bg-secondary rounded overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${Math.min(100, a.pct * 10)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3"><TrendingUp className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">Correlation Matrix (top pairs)</h3></div>
              {r.correlationPairs.length === 0 ? (
                <div className="text-xs text-muted-foreground">Need ≥2 open positions.</div>
              ) : r.correlationPairs.map((p, i) => (
                <Row key={i} k={`${p.a} ↔ ${p.b}`} v={p.corr.toFixed(3)}
                  danger={Math.abs(p.corr) > 0.8} />
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="text-sm font-semibold mb-2">Advisories</h3>
            <ul className="text-xs space-y-1 text-muted-foreground">
              {r.advisories.map((a, i) => <li key={i}>• {a}</li>)}
            </ul>
          </div>

          {/* Settings */}
          {current && (
            <div className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-sm font-semibold mb-3">Risk Limits</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { key: "max_portfolio_heat_pct", label: "Max Heat %", step: 0.5 },
                  { key: "max_correlation", label: "Max |Correlation|", step: 0.05 },
                  { key: "max_var_pct", label: "Max VaR95 %", step: 0.5 },
                  { key: "target_daily_vol_pct", label: "Target Daily Vol %", step: 0.1 },
                  { key: "kelly_fraction", label: "Kelly Fraction", step: 0.05 },
                  { key: "max_sector_pct", label: "Max Sector %", step: 5 },
                ].map(f => (
                  <label key={f.key} className="text-xs">
                    <div className="text-muted-foreground mb-1 font-mono uppercase">{f.label}</div>
                    <input type="number" step={f.step} value={current[f.key]}
                      onChange={e => setForm({ ...current, [f.key]: Number(e.target.value) })}
                      className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono" />
                  </label>
                ))}
              </div>
              <div className="flex gap-2 mt-3">
                <button disabled={saveMut.isPending || !form}
                  onClick={() => form && saveMut.mutate(form)}
                  className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-mono uppercase disabled:opacity-50">
                  {saveMut.isPending ? "Saving…" : "Save Limits"}
                </button>
                {form && <button onClick={() => setForm(null)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase">
                  Reset
                </button>}
              </div>
            </div>
          )}

          {/* Position sizer */}
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3"><Calculator className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold">Dynamic Position Sizer</h3></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <label className="text-xs"><div className="text-muted-foreground mb-1 font-mono uppercase">Symbol</div>
                <input value={sizer.symbol} onChange={e => setSizer({...sizer, symbol: e.target.value.toUpperCase() })}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono" /></label>
              <label className="text-xs"><div className="text-muted-foreground mb-1 font-mono uppercase">Entry</div>
                <input type="number" value={sizer.entry} onChange={e => setSizer({...sizer, entry: Number(e.target.value)})}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono" /></label>
              <label className="text-xs"><div className="text-muted-foreground mb-1 font-mono uppercase">Stop</div>
                <input type="number" value={sizer.stopLoss} onChange={e => setSizer({...sizer, stopLoss: Number(e.target.value)})}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono" /></label>
              <label className="text-xs"><div className="text-muted-foreground mb-1 font-mono uppercase">Confidence 0-1</div>
                <input type="number" step="0.05" value={sizer.confidence} onChange={e => setSizer({...sizer, confidence: Number(e.target.value)})}
                  className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono" /></label>
            </div>
            <button onClick={() => sizeMut.mutate()} disabled={sizeMut.isPending}
              className="mt-3 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-mono uppercase disabled:opacity-50">
              {sizeMut.isPending ? "Sizing…" : "Suggest Size"}
            </button>
            {sizeMut.data && (
              <div className="mt-3 rounded-md border border-border bg-secondary/30 p-3">
                <Row k="Suggested Qty" v={sizeMut.data.result.qty.toFixed(6)} />
                <Row k="Notional" v={fmtUsd(sizeMut.data.result.notional)} />
                <Row k="Risk $" v={fmtUsd(sizeMut.data.result.riskUsd)} />
                <Row k="Risk %" v={`${sizeMut.data.result.riskPct.toFixed(2)}%`} />
                <Row k="Asset Vol (daily)" v={`${sizeMut.data.result.volDailyPct.toFixed(2)}%`} />
                <Row k="Kelly Edge" v={`${(sizeMut.data.result.kellyEdge*100).toFixed(0)}%`} />
                <div className="text-[11px] text-muted-foreground mt-2 space-y-0.5">
                  {(sizeMut.data.result.reasoning as string[]).map((r: string, i: number) => <div key={i}>• {r}</div>)}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </AppShell>
  );
}
