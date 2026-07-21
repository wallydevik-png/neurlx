import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd } from "@/components/AppShell";
import { getCapitalGrowth, snapshotCapital } from "@/lib/liveIntel.functions";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from "recharts";
import { Wallet, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/capital")({
  head: () => ({ meta: [{ title: "Capital Growth — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: CapitalPage,
});

function CapitalPage() {
  const getFn = useServerFn(getCapitalGrowth);
  const snapFn = useServerFn(snapshotCapital);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["capital-growth"], queryFn: () => getFn(), refetchInterval: 60000,
  });

  const snap = useMutation({
    mutationFn: () => snapFn(),
    onSuccess: () => { toast.success("Snapshot recorded"); qc.invalidateQueries({ queryKey: ["capital-growth"] }); },
  });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading capital…</div></AppShell>;

  const { current, series, monthly, compoundPct } = data;

  return (
    <AppShell>
      <PageHeader
        title="Capital Growth"
        subtitle="Portfolio equity over time, monthly returns, and exposure. Snapshots run automatically as trades close."
      />

      <div className="flex justify-end mb-3">
        <button onClick={() => snap.mutate()} disabled={snap.isPending}
          className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase rounded border border-border hover:bg-secondary">
          <RefreshCw className={`w-3.5 h-3.5 ${snap.isPending ? "animate-spin" : ""}`} />
          Snapshot now
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Metric label="Total equity" value={fmtUsd(current.equity)} />
        <Metric label="Cash" value={fmtUsd(current.cash)} />
        <Metric label="Realized total" value={fmtUsd(current.realizedTotal)}
          tone={current.realizedTotal >= 0 ? "pos" : "neg"} />
        <Metric label="Open positions" value={String(current.openPositions)} />
        <Metric label="Compound return" value={`${(compoundPct * 100).toFixed(2)}%`}
          tone={compoundPct >= 0 ? "pos" : "neg"} />
      </div>

      <section className="panel p-5 mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Wallet className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">Equity curve</h2>
        </div>
        {series.length < 2 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            Not enough snapshots yet — check back after more trades close, or press &ldquo;Snapshot now&rdquo;.
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="date" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Line type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <section className="panel p-5 mt-4">
        <h2 className="font-semibold mb-3">Monthly returns</h2>
        {monthly.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No closed trades yet.</div>
        ) : (
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Bar dataKey="pnl" fill="hsl(var(--primary))" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="panel p-5">
          <h3 className="font-semibold mb-2">Exposure</h3>
          <div className="text-sm space-y-1.5">
            <div className="flex justify-between"><span>Gross exposure</span><span className="font-mono">{fmtUsd(current.grossExposure)}</span></div>
            <div className="flex justify-between"><span>Exposure vs equity</span>
              <span className="font-mono">{(current.exposurePct * 100).toFixed(1)}%</span></div>
          </div>
        </div>
        <div className="panel p-5">
          <h3 className="font-semibold mb-2">Withdrawal history</h3>
          <p className="text-xs text-muted-foreground">No withdrawals recorded. This ledger will populate once withdrawal tracking ships.</p>
        </div>
      </div>
    </AppShell>
  );
}
