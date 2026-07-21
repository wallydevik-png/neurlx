import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd, fmtNum } from "@/components/AppShell";
import { generateAndRouteSignal, listSignals, evaluateSignalOutcomes } from "@/lib/trading.functions";
import { toast } from "sonner";
import { Sparkles, TrendingUp, TrendingDown, ChevronDown, ChevronUp, AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/signals")({
  head: () => ({ meta: [{ title: "AI Signals — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Signals,
});

interface Contribution { indicator: string; signal: "bullish" | "bearish" | "neutral"; weight: number; detail: string }

function Signals() {
  const fetchFn = useServerFn(listSignals);
  const genFn = useServerFn(generateAndRouteSignal);
  const evalFn = useServerFn(evaluateSignalOutcomes);
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["signals"], queryFn: () => fetchFn(), refetchInterval: 15000 });

  async function generate() {
    try { await genFn({ data: {} }); toast.success("New signal generated"); qc.invalidateQueries(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function evaluate() {
    try { const r = await evalFn(); toast.success(`Evaluated ${r.evaluated} past signals`); qc.invalidateQueries(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader
        title="AI Signals"
        subtitle="Every signal shows the indicators that drove it, the market regime, and the risk factors."
        action={
          <div className="flex gap-2">
            <button onClick={evaluate}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-secondary/50">
              <RefreshCw className="w-4 h-4" /> Evaluate outcomes
            </button>
            <button onClick={generate}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
              <Sparkles className="w-4 h-4" /> Generate signal
            </button>
          </div>
        }
      />

      {data.length === 0 ? (
        <div className="panel p-10 text-center text-muted-foreground text-sm">
          No signals yet. Use the market scanner or generate one to see the AI reasoning breakdown.
        </div>
      ) : (
        <div className="space-y-3">
          {data.map(s => <SignalCard key={s.id} s={s} />)}
        </div>
      )}
    </AppShell>
  );
}

type SignalRow = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof listSignals>>>>[number];

function SignalCard({ s }: { s: SignalRow }) {
  const [open, setOpen] = useState(false);
  const contribs = (s.contributions as unknown as Contribution[]) ?? [];
  const risks = (s.risk_factors as unknown as string[]) ?? [];
  const indicators = (s.indicators as unknown as Record<string, number | string | null>) ?? {};
  const buy = s.side === "buy";
  const conf = Number(s.confidence);

  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-md grid place-items-center ${buy ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>
            {buy ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          </div>
          <div>
            <div className="font-semibold font-mono">{s.symbol} <span className="text-xs uppercase text-muted-foreground">{s.side}</span></div>
            <div className="text-xs text-muted-foreground">
              {new Date(s.created_at).toLocaleString()}
              {s.market_regime && <> · <span className="font-mono">{String(s.market_regime).replace(/_/g, " ")}</span></>}
              {s.time_horizon && <> · {s.time_horizon}</>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <RiskChip level={String(s.risk_level ?? "medium")} />
          <OutcomeChip status={s.outcome_status} pnl={s.outcome_pnl_pct} />
          <StatusBadge status={s.status} />
        </div>
      </div>

      <p className="mt-4 text-sm text-muted-foreground italic">"{s.reasoning}"</p>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
        <Stat k="Entry" v={fmtUsd(s.entry)} />
        <Stat k="Stop" v={fmtUsd(s.stop_loss)} />
        <Stat k="Target" v={fmtUsd(s.take_profit)} />
        <Stat k="Qty" v={fmtNum(s.qty, 6)} />
        <Stat k="R:R" v={fmtNum(s.risk_reward, 2)} />
        <Stat k="Confidence" v={(conf * 100).toFixed(0) + "%"} tone={conf > 0.75 ? "pos" : undefined} />
      </div>

      <button onClick={() => setOpen(!open)}
        className="mt-4 inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        {open ? "Hide" : "Show"} AI explainability
      </button>

      {open && (
        <div className="mt-4 grid md:grid-cols-2 gap-5 border-t border-border pt-4">
          <div>
            <div className="text-xs font-mono uppercase text-muted-foreground mb-2">Indicator contributions</div>
            <div className="space-y-1.5">
              {contribs.length === 0 && <div className="text-xs text-muted-foreground">No breakdown recorded.</div>}
              {contribs.map((c, i) => (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <span className="w-24 font-mono">{c.indicator}</span>
                  <div className="flex-1 h-1.5 bg-secondary rounded overflow-hidden relative">
                    <div className={`absolute top-0 h-full ${c.weight > 0 ? "bg-success left-1/2" : c.weight < 0 ? "bg-destructive right-1/2" : "bg-muted-foreground"}`}
                         style={{ width: `${Math.abs(c.weight) * 100}%` }} />
                    <div className="absolute top-0 left-1/2 h-full w-px bg-border" />
                  </div>
                  <span className="w-40 text-muted-foreground truncate" title={c.detail}>{c.detail}</span>
                </div>
              ))}
            </div>

            {risks.length > 0 && (
              <div className="mt-4">
                <div className="text-xs font-mono uppercase text-muted-foreground mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-warning" /> Risk factors
                </div>
                <ul className="space-y-1 text-xs text-muted-foreground list-disc pl-4">
                  {risks.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-mono uppercase text-muted-foreground mb-2">Indicator snapshot</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs font-mono">
              {Object.entries(indicators).map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-border/50 py-0.5">
                  <span className="text-muted-foreground">{k}</span>
                  <span>{v === null ? "—" : String(v)}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 text-[10px] text-muted-foreground italic">
              Past performance does not guarantee future results. This system does not promise profit.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: "pos" }) {
  return (
    <div>
      <div className="text-[10px] font-mono uppercase text-muted-foreground">{k}</div>
      <div className={`font-mono ${tone === "pos" ? "text-success" : ""}`}>{v}</div>
    </div>
  );
}
function StatusBadge({ status }: { status: string }) {
  const c = { pending: "bg-warning/15 text-warning", executed: "bg-success/15 text-success", approved: "bg-success/15 text-success", rejected: "bg-destructive/15 text-destructive", expired: "bg-muted text-muted-foreground" }[status] ?? "bg-muted text-muted-foreground";
  return <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${c}`}>{status}</span>;
}
function RiskChip({ level }: { level: string }) {
  const c = level === "high" ? "bg-destructive/15 text-destructive" : level === "low" ? "bg-success/15 text-success" : "bg-warning/15 text-warning";
  return <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${c}`}>{level} risk</span>;
}
function OutcomeChip({ status, pnl }: { status: string | null; pnl: number | null }) {
  if (!status) return null;
  if (status === "hit_tp") return <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-success/15 text-success">TP · {pnl?.toFixed(2)}%</span>;
  if (status === "hit_sl") return <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-destructive/15 text-destructive">SL · {pnl?.toFixed(2)}%</span>;
  return <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-muted text-muted-foreground">open · {pnl?.toFixed(2) ?? "—"}%</span>;
}
