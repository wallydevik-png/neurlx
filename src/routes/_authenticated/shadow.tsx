import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd, fmtPct } from "@/components/AppShell";
import { listShadowTrades, recordShadowFromSignal, evaluateShadowTrades } from "@/lib/portfolio.functions";
import { toast } from "sonner";
import { EyeOff } from "lucide-react";

export const Route = createFileRoute("/_authenticated/shadow")({
  head: () => ({ meta: [{ title: "Shadow Mode — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Shadow,
});

function Shadow() {
  const listFn = useServerFn(listShadowTrades);
  const recordFn = useServerFn(recordShadowFromSignal);
  const evalFn = useServerFn(evaluateShadowTrades);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["shadow"], queryFn: () => listFn(), refetchInterval: 30000 });

  async function record() {
    try { const r = await recordFn({ data: {} }); toast.success(`Recorded shadow ${r.side.toUpperCase()} ${r.symbol}`); qc.invalidateQueries({ queryKey: ["shadow"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function ev() {
    try { const r = await evalFn(); toast.success(`Closed ${r.closed} shadow trade${r.closed===1?'':'s'}`); qc.invalidateQueries({ queryKey: ["shadow"] }); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  const trades = data?.trades ?? [];
  const s = data?.stats;

  return (
    <AppShell>
      <PageHeader
        title="Shadow Mode"
        subtitle="Record what the AI would have done in real markets — no execution, no capital at risk. Run this for 30–60 days before live."
        action={<div className="flex gap-2">
          <button onClick={ev} className="rounded-md border border-border px-3 py-1.5 text-xs font-mono uppercase">Evaluate open</button>
          <button onClick={record} className="rounded-md bg-primary px-3 py-1.5 text-xs font-mono uppercase text-primary-foreground">Record shadow trade</button>
        </div>}
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Metric label="Total" value={String(s?.total ?? 0)} sub={`${s?.open ?? 0} open · ${s?.closed ?? 0} closed`} />
        <Metric label="Win rate" value={s?.closed ? fmtPct(s.winRate) : "—"} />
        <Metric label="Shadow P&L" value={fmtUsd(s?.totalPnl ?? 0)} tone={(s?.totalPnl ?? 0) >= 0 ? "pos" : "neg"} />
        <Metric label="Avg P&L %" value={s?.closed ? `${(s.avgPnlPct*100).toFixed(2)}%` : "—"} />
      </div>

      <div className="panel p-6 mt-4">
        <div className="flex items-center gap-2">
          <EyeOff className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Recorded shadow trades</h2>
        </div>
        {trades.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No shadow trades yet. Click "Record shadow trade" to snapshot the top current opportunity — the AI will track it against real prices without executing.</p>
        ) : (
          <table className="mt-3 w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground">
              <tr className="border-b border-border">
                <th className="text-left py-2">Symbol</th><th>Side</th><th className="text-right">Entry</th>
                <th className="text-right">SL</th><th className="text-right">TP</th><th className="text-right">Conf.</th>
                <th>Status</th><th className="text-right">P&L</th><th className="text-right">P&L %</th>
              </tr>
            </thead>
            <tbody>
              {trades.map(t => (
                <tr key={t.id} className="border-b border-border/50">
                  <td className="py-1.5 font-mono">{t.symbol}</td>
                  <td className="font-mono uppercase text-xs">{t.side}</td>
                  <td className="text-right font-mono">{Number(t.entry_price).toFixed(2)}</td>
                  <td className="text-right font-mono">{Number(t.stop_loss).toFixed(2)}</td>
                  <td className="text-right font-mono">{Number(t.take_profit).toFixed(2)}</td>
                  <td className="text-right font-mono">{(Number(t.confidence)*100).toFixed(0)}%</td>
                  <td className="text-xs font-mono uppercase text-muted-foreground">{t.status}{t.exit_reason ? ` · ${t.exit_reason}` : ""}</td>
                  <td className={`text-right font-mono ${Number(t.pnl ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>{t.pnl != null ? fmtUsd(Number(t.pnl)) : "—"}</td>
                  <td className={`text-right font-mono ${Number(t.pnl_pct ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>{t.pnl_pct != null ? `${(Number(t.pnl_pct)*100).toFixed(2)}%` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
