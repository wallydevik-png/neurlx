import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd, fmtNum } from "@/components/AppShell";
import { scanMarketOpportunities, generateAndRouteSignal } from "@/lib/trading.functions";
import { TrendingUp, TrendingDown, Minus, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/market")({
  head: () => ({ meta: [{ title: "Market Scanner — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Market,
});

function Market() {
  const scanFn = useServerFn(scanMarketOpportunities);
  const genFn = useServerFn(generateAndRouteSignal);
  const qc = useQueryClient();
  const { data = [], isFetching, refetch } = useQuery({
    queryKey: ["market-scan"], queryFn: () => scanFn(), refetchInterval: 60000,
  });

  async function generateFor(symbol: string) {
    try { await genFn({ data: { symbol } }); toast.success(`Signal generated for ${symbol}`); qc.invalidateQueries({ queryKey: ["signals"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  const regimeCounts = data.reduce<Record<string, number>>((acc, r) => { acc[r.regimeLabel] = (acc[r.regimeLabel] ?? 0) + 1; return acc; }, {});

  return (
    <AppShell>
      <PageHeader
        title="Market Scanner"
        subtitle="AI analyzes every supported asset and ranks opportunities by conviction. Not a guarantee of future performance."
        action={<button onClick={() => refetch()} disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary/50">
          <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} /> Rescan
        </button>}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {Object.entries(regimeCounts).map(([k, v]) => (
          <span key={k} className="text-xs font-mono px-2 py-1 rounded bg-secondary/60 border border-border">
            {k}: <b>{v}</b>
          </span>
        ))}
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-[10px] font-mono uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2">Symbol</th>
              <th className="text-left px-4 py-2">Direction</th>
              <th className="text-right px-4 py-2">Conf.</th>
              <th className="text-left px-4 py-2">Regime</th>
              <th className="text-right px-4 py-2">Price</th>
              <th className="text-right px-4 py-2">RSI</th>
              <th className="text-right px-4 py-2">ATR%</th>
              <th className="text-left px-4 py-2">Trend</th>
              <th className="text-left px-4 py-2">Risk</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map(row => (
              <tr key={row.symbol} className="hover:bg-secondary/20">
                <td className="px-4 py-2.5 font-mono font-medium">{row.symbol}</td>
                <td className="px-4 py-2.5"><DirBadge dir={row.direction} /></td>
                <td className="px-4 py-2.5 text-right font-mono">
                  <ConfBar score={row.confidenceScore} />
                </td>
                <td className="px-4 py-2.5 text-xs text-muted-foreground">{row.regimeLabel}</td>
                <td className="px-4 py-2.5 text-right font-mono">{fmtUsd(row.entry)}</td>
                <td className="px-4 py-2.5 text-right font-mono">{row.indicators.rsi != null ? fmtNum(row.indicators.rsi, 1) : "—"}</td>
                <td className="px-4 py-2.5 text-right font-mono">{row.indicators.atr_pct != null ? String(row.indicators.atr_pct) + "%" : "—"}</td>
                <td className="px-4 py-2.5 text-xs font-mono uppercase">{String(row.indicators.trend ?? "")}</td>
                <td className="px-4 py-2.5"><RiskBadge level={row.riskLevel} /></td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={() => generateFor(row.symbol)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary/15 text-primary px-2.5 py-1 text-xs font-medium hover:bg-primary/25">
                    <Sparkles className="w-3.5 h-3.5" /> Signal
                  </button>
                </td>
              </tr>
            ))}
            {!data.length && (
              <tr><td colSpan={10} className="text-center text-muted-foreground py-8 text-sm">Scanning market…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}

function DirBadge({ dir }: { dir: string }) {
  if (dir === "buy") return <span className="inline-flex items-center gap-1 text-success text-xs font-mono uppercase"><TrendingUp className="w-3.5 h-3.5" /> Buy</span>;
  if (dir === "sell") return <span className="inline-flex items-center gap-1 text-destructive text-xs font-mono uppercase"><TrendingDown className="w-3.5 h-3.5" /> Sell</span>;
  return <span className="inline-flex items-center gap-1 text-muted-foreground text-xs font-mono uppercase"><Minus className="w-3.5 h-3.5" /> Wait</span>;
}
function ConfBar({ score }: { score: number }) {
  const color = score >= 75 ? "bg-success" : score >= 55 ? "bg-primary" : "bg-muted-foreground";
  return (
    <div className="flex items-center gap-2 justify-end">
      <div className="w-16 h-1.5 bg-secondary rounded overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${score}%` }} /></div>
      <span className="tabular w-8 text-right">{score}</span>
    </div>
  );
}
function RiskBadge({ level }: { level: string }) {
  const c = level === "high" ? "bg-destructive/15 text-destructive" : level === "low" ? "bg-success/15 text-success" : "bg-warning/15 text-warning";
  return <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${c}`}>{level}</span>;
}
