import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd, fmtNum } from "@/components/AppShell";
import { listSignals, rejectSignal } from "@/lib/trading.functions";
import { approveSignalV2 } from "@/lib/assistedLive.functions";
import { toast } from "sonner";
import { Check, X, Sliders } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/approvals")({
  head: () => ({ meta: [{ title: "Approvals — Helix" }, { name: "robots", content: "noindex" }] }),
  component: Approvals,
});

const FEE_BPS = 10; // 0.10% paper fee — kept in sync with the paper connector

function Approvals() {
  const fetchFn = useServerFn(listSignals);
  const approve = useServerFn(approveSignalV2);
  const reject = useServerFn(rejectSignal);
  const qc = useQueryClient();

  const { data: all = [] } = useQuery({
    queryKey: ["signals"], queryFn: () => fetchFn(), refetchInterval: 10000,
  });
  const pending = all.filter(s => s.status === "pending");

  async function onApprove(id: string, modifiedQty?: number) {
    try {
      const r = await approve({ data: { signalId: id, modifiedQty } });
      toast.success(r.partial
        ? `Partial fill @ ${fmtUsd(r.filledPrice)} (${fmtNum(r.filledQty, 6)})`
        : `Filled @ ${fmtUsd(r.filledPrice)}`);
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Rejected by risk gate"); }
  }
  async function onReject(id: string) {
    try {
      await reject({ data: { signalId: id } });
      toast.success("Signal rejected");
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader
        title="Assisted Trade Approvals"
        subtitle="Every AI-proposed trade requires your explicit approval. You can adjust position size before approving."
      />

      {pending.length === 0 ? (
        <div className="panel p-10 text-center text-muted-foreground text-sm">
          No pending approvals. Generate a signal from the AI Signals page.
        </div>
      ) : (
        <div className="space-y-4">
          {pending.map(s => (
            <ApprovalCard key={s.id} signal={s} onApprove={onApprove} onReject={onReject} />
          ))}
        </div>
      )}
    </AppShell>
  );
}

interface SignalRow {
  id: string; symbol: string; side: string; entry: number | string;
  qty: number | string; stop_loss: number | string; take_profit: number | string;
  confidence: number | string; risk_reward: number | string | null;
  reasoning: string | null; risk_level?: string | null; market_regime?: string | null;
  time_horizon?: string | null; expires_at?: string | null;
  indicators?: unknown; contributions?: unknown; risk_factors?: unknown;
}

function ApprovalCard({
  signal: s, onApprove, onReject,
}: {
  signal: SignalRow;
  onApprove: (id: string, modQty?: number) => void;
  onReject: (id: string) => void;
}) {
  const [modifying, setModifying] = useState(false);
  const [qty, setQty] = useState<string>(String(s.qty));
  const [showDetail, setShowDetail] = useState(false);

  const activeQty = Number(qty) || Number(s.qty);
  const notional = activeQty * Number(s.entry);
  const estFees = notional * (FEE_BPS / 10_000);
  const potentialLoss = Math.abs(Number(s.entry) - Number(s.stop_loss)) * activeQty;
  const potentialGain = Math.abs(Number(s.take_profit) - Number(s.entry)) * activeQty;

  return (
    <div className="panel p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="text-lg font-semibold font-mono">{s.symbol}</div>
        <span className={`text-xs uppercase font-mono px-2 py-0.5 rounded ${
          s.side === "buy" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
        }`}>{s.side}</span>
        {s.market_regime && (
          <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-secondary text-muted-foreground">
            {s.market_regime.replace(/_/g, " ")}
          </span>
        )}
        {s.risk_level && (
          <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${
            s.risk_level === "high" ? "bg-destructive/15 text-destructive"
              : s.risk_level === "medium" ? "bg-warning/15 text-warning"
              : "bg-success/15 text-success"
          }`}>{s.risk_level} risk</span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto font-mono">
          Expires {s.expires_at ? new Date(s.expires_at).toLocaleTimeString() : "soon"}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <Info k="Entry" v={fmtUsd(s.entry)} />
        <Info k="Confidence" v={<span className="text-success">{(Number(s.confidence) * 100).toFixed(0)}%</span>} />
        <Info k="Stop" v={<span className="text-destructive">{fmtUsd(s.stop_loss)}</span>} />
        <Info k="Target" v={<span className="text-success">{fmtUsd(s.take_profit)}</span>} />
        <Info k="R/R" v={fmtNum(s.risk_reward, 2) + "×"} />
        <Info k="Horizon" v={s.time_horizon ?? "—"} />
        <Info k="Est. fees" v={fmtUsd(estFees)} sub="0.10% paper" />
        <Info k="Notional" v={fmtUsd(notional)} sub={fmtNum(activeQty, 6) + " units"} />
      </div>

      {modifying && (
        <div className="mt-4 p-3 rounded-md border border-primary/40 bg-primary/5">
          <div className="text-[10px] uppercase font-mono text-primary mb-2">Modify position size</div>
          <div className="flex items-center gap-3">
            <input
              type="number" step="0.00000001" min="0" value={qty} onChange={e => setQty(e.target.value)}
              className="flex-1 px-3 py-2 rounded-md bg-input border border-border font-mono text-sm"
            />
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              Potential: <span className="text-success">+{fmtUsd(potentialGain)}</span> /
              <span className="text-destructive"> -{fmtUsd(potentialLoss)}</span>
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 p-3 rounded-md border border-border bg-secondary/30">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase font-mono text-muted-foreground">AI reasoning</div>
          <button onClick={() => setShowDetail(v => !v)} className="text-[10px] uppercase font-mono text-primary hover:underline">
            {showDetail ? "Hide" : "Show"} indicators
          </button>
        </div>
        <p className="text-sm mt-1">{s.reasoning}</p>
        {showDetail && s.contributions && (
          <div className="mt-3 space-y-1.5">
            {(s.contributions ?? []).map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs font-mono">
                <span className={`w-16 text-right ${
                  c.direction === "bull" ? "text-success" : c.direction === "bear" ? "text-destructive" : "text-muted-foreground"
                }`}>{c.direction}</span>
                <span className="flex-1">{c.name}</span>
                <span className="text-muted-foreground">weight {c.weight.toFixed(2)}</span>
              </div>
            ))}
            {s.risk_factors && s.risk_factors.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border">
                <div className="text-[10px] uppercase font-mono text-warning mb-1">Risk factors</div>
                {s.risk_factors.map((r, i) => (
                  <div key={i} className="text-xs text-warning">• {r}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => onApprove(s.id, modifying ? Number(qty) : undefined)}
          className="inline-flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-sm font-medium text-success-foreground">
          <Check className="w-4 h-4" /> Approve {modifying && "modified"}
        </button>
        <button onClick={() => setModifying(v => !v)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-secondary">
          <Sliders className="w-4 h-4" /> {modifying ? "Cancel modify" : "Modify size"}
        </button>
        <button onClick={() => onReject(s.id)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-destructive hover:text-destructive-foreground hover:border-destructive ml-auto">
          <X className="w-4 h-4" /> Reject
        </button>
      </div>
    </div>
  );
}

function Info({ k, v, sub }: { k: string; v: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-mono text-muted-foreground">{k}</div>
      <div className="font-mono mt-0.5">{v}</div>
      {sub && <div className="text-[10px] text-muted-foreground font-mono">{sub}</div>}
    </div>
  );
}
