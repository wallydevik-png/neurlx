import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell, PageHeader, fmtPct, fmtUsd } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import {
  runBacktestFn, runWalkForwardFn, listBacktests, listStrategies, saveStrategy, deleteStrategy,
} from "@/lib/backtest.functions";

export const Route = createFileRoute("/_authenticated/lab")({
  head: () => ({ meta: [{ title: "Strategy Lab — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Lab,
});

const SYMBOLS = ["BTC-USD","ETH-USD","SOL-USD","ADA-USD","AVAX-USD","LINK-USD","DOGE-USD","MATIC-USD","AAPL","TSLA","NVDA"];
const INTERVALS = ["5m","15m","1h","4h","1d"] as const;

function Lab() {
  const qc = useQueryClient();
  const runFn = useServerFn(runBacktestFn);
  const walkFn = useServerFn(runWalkForwardFn);
  const listFn = useServerFn(listBacktests);
  const stratListFn = useServerFn(listStrategies);
  const saveFn = useServerFn(saveStrategy);
  const delFn = useServerFn(deleteStrategy);

  const { data: runs = [] } = useQuery({ queryKey: ["backtests"], queryFn: () => listFn() });
  const { data: strategies = [] } = useQuery({ queryKey: ["strategies"], queryFn: () => stratListFn() });

  const [form, setForm] = useState({
    symbol: "BTC-USD",
    interval: "15m" as (typeof INTERVALS)[number],
    bars: 500,
    minConfidence: 0.55,
    riskPerTradePct: 0.01,
    feeBps: 10,
    slippageBps: 5,
    maxBarsInTrade: 40,
    label: "",
  });
  const [name, setName] = useState("");

  const single = useMutation({
    mutationFn: () => runFn({ data: form }),
    onSuccess: (r) => { toast.success(`Backtest complete — ${r.trades} trades`); qc.invalidateQueries({ queryKey: ["backtests"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const walk = useMutation({
    mutationFn: () => walkFn({ data: form }),
    onSuccess: () => { toast.success("Walk-forward complete"); qc.invalidateQueries({ queryKey: ["backtests"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const save = useMutation({
    mutationFn: () => saveFn({ data: { name, symbol: form.symbol, interval: form.interval, params: {
      minConfidence: form.minConfidence, riskPerTradePct: form.riskPerTradePct,
      feeBps: form.feeBps, slippageBps: form.slippageBps, maxBarsInTrade: form.maxBarsInTrade, bars: form.bars,
    } } }),
    onSuccess: () => { toast.success("Strategy saved"); setName(""); qc.invalidateQueries({ queryKey: ["strategies"] }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  const del = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
  });

  const busy = single.isPending || walk.isPending;

  return (
    <AppShell>
      <PageHeader title="Strategy Lab" subtitle="Replay historical data, measure statistical edge, and prevent overfitting with walk-forward validation. Paper only." />

      <div className="grid lg:grid-cols-[2fr,1fr] gap-6">
        <div className="panel p-6 space-y-4">
          <h2 className="font-semibold">Configure simulation</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Asset</Label>
              <Select value={form.symbol} onValueChange={v => setForm({ ...form, symbol: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{SYMBOLS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Timeframe</Label>
              <Select value={form.interval} onValueChange={v => setForm({ ...form, interval: v as typeof form.interval })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{INTERVALS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Bars</Label><Input type="number" value={form.bars} onChange={e => setForm({ ...form, bars: +e.target.value })} /></div>
            <div><Label>Min confidence</Label><Input type="number" step="0.05" value={form.minConfidence} onChange={e => setForm({ ...form, minConfidence: +e.target.value })} /></div>
            <div><Label>Risk / trade (%)</Label><Input type="number" step="0.001" value={form.riskPerTradePct} onChange={e => setForm({ ...form, riskPerTradePct: +e.target.value })} /></div>
            <div><Label>Max bars in trade</Label><Input type="number" value={form.maxBarsInTrade} onChange={e => setForm({ ...form, maxBarsInTrade: +e.target.value })} /></div>
            <div><Label>Fee (bps)</Label><Input type="number" value={form.feeBps} onChange={e => setForm({ ...form, feeBps: +e.target.value })} /></div>
            <div><Label>Slippage (bps)</Label><Input type="number" value={form.slippageBps} onChange={e => setForm({ ...form, slippageBps: +e.target.value })} /></div>
            <div className="col-span-2"><Label>Label (optional)</Label><Input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="e.g. Baseline BTC 15m" /></div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button onClick={() => single.mutate()} disabled={busy}>{single.isPending ? "Running…" : "Run backtest"}</Button>
            <Button variant="outline" onClick={() => walk.mutate()} disabled={busy}>{walk.isPending ? "Running…" : "Run walk-forward"}</Button>
          </div>
        </div>

        <div className="panel p-6 space-y-4">
          <h2 className="font-semibold">Save as strategy</h2>
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Baseline BTC 15m" />
          </div>
          <Button size="sm" onClick={() => save.mutate()} disabled={!name || save.isPending}>Save current config</Button>
          <div className="pt-3 border-t border-border space-y-2">
            <div className="text-xs font-mono text-muted-foreground">SAVED STRATEGIES</div>
            {strategies.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
            {strategies.map(s => (
              <div key={s.id} className="flex items-center justify-between text-sm gap-2">
                <button onClick={() => setForm(f => ({ ...f, symbol: s.symbol, interval: s.interval as typeof f.interval, ...(s.params as Record<string, number>) }))}
                  className="text-left flex-1 hover:text-primary truncate">
                  {s.name} <span className="text-muted-foreground text-xs">· {s.symbol} · {s.interval}</span>
                </button>
                <button onClick={() => del.mutate(s.id)} className="text-xs text-destructive hover:underline">Delete</button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel p-6 mt-6">
        <h2 className="font-semibold mb-4">Recent runs</h2>
        {runs.length === 0 && <p className="text-sm text-muted-foreground">No backtests yet. Configure and run one above.</p>}
        <div className="space-y-2">
          {runs.map(r => {
            const m = (r.metrics as Record<string, number>) ?? {};
            return (
              <Link key={r.id} to="/backtests/$id" params={{ id: r.id }}
                className="flex items-center justify-between panel p-4 hover:border-primary/40 transition">
                <div>
                  <div className="font-medium text-sm">{r.label ?? `${r.symbol} · ${r.interval}`}</div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {r.kind === "single" ? "single" : "walk-forward"} · {new Date(r.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex gap-6 text-xs font-mono">
                  <div><span className="text-muted-foreground">RET </span><span className={Number(m.totalReturnPct) >= 0 ? "text-success" : "text-destructive"}>{fmtPct(Number(m.totalReturnPct ?? 0))}</span></div>
                  <div><span className="text-muted-foreground">WIN </span>{fmtPct(Number(m.winRate ?? 0))}</div>
                  <div><span className="text-muted-foreground">PF </span>{Number(m.profitFactor ?? 0).toFixed(2)}</div>
                  <div><span className="text-muted-foreground">DD </span><span className="text-destructive">{fmtPct(Number(m.maxDrawdown ?? 0))}</span></div>
                  <div><span className="text-muted-foreground">SHRP </span>{Number(m.sharpe ?? 0).toFixed(2)}</div>
                  <div><span className="text-muted-foreground">EQ </span>{fmtUsd(Number(m.finalEquity ?? 0))}</div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </AppShell>
  );
}
