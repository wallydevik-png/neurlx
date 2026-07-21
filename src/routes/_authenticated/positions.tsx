import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd, fmtNum } from "@/components/AppShell";
import { listPositions } from "@/lib/trading.functions";
import {
  closePositionV2, movePositionStop, reducePositionSize, addToPositionSize,
  tickProfitProtection,
} from "@/lib/assistedLive.functions";
import { toast } from "sonner";
import { useState } from "react";
import { Shield, TrendingDown, Plus, X as CloseIcon, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/positions")({
  head: () => ({ meta: [{ title: "Positions — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Positions,
});

function Positions() {
  const fetchFn = useServerFn(listPositions);
  const close = useServerFn(closePositionV2);
  const moveStop = useServerFn(movePositionStop);
  const reduce = useServerFn(reducePositionSize);
  const add = useServerFn(addToPositionSize);
  const tick = useServerFn(tickProfitProtection);
  const qc = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["positions"], queryFn: () => fetchFn(), refetchInterval: 5000 });
  const open = data.filter(p => p.status === "open");

  async function runTick() {
    try {
      const r = await tick();
      toast.success(`Profit-protection ran (${r.profitProtectionActions} actions, ${r.workingOrdersTriggered} orders triggered)`);
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader
        title="Open Positions"
        subtitle="Live monitoring with mark price, unrealized P&L, and profit protection."
        action={
          <button onClick={runTick} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary">
            <Zap className="w-3.5 h-3.5" /> Run profit protection
          </button>
        }
      />
      {open.length === 0 ? (
        <div className="panel p-10 text-center text-muted-foreground text-sm">No open positions.</div>
      ) : (
        <div className="space-y-3">
          {open.map(p => (
            <PositionCard
              key={p.id} position={p}
              onClose={async () => {
                if (!confirm("Close this position at current market?")) return;
                try { await close({ data: { positionId: p.id, reason: "manual" } }); toast.success("Closed"); qc.invalidateQueries(); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}
              onMoveStop={async (newStop) => {
                try { await moveStop({ data: { positionId: p.id, newStop } }); toast.success("Stop moved"); qc.invalidateQueries(); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}
              onReduce={async (q) => {
                try { await reduce({ data: { positionId: p.id, reduceQty: q } }); toast.success("Reduced"); qc.invalidateQueries(); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}
              onAdd={async (q) => {
                try { await add({ data: { positionId: p.id, addQty: q } }); toast.success("Added"); qc.invalidateQueries(); }
                catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
              }}
            />
          ))}
        </div>
      )}
    </AppShell>
  );
}

interface PosRow {
  id: string; symbol: string; side: string;
  qty: number | string; avg_entry: number | string;
  stop_loss: number | string | null; take_profit: number | string | null;
  currentPrice: number | null; opened_at: string;
  ai_reasoning?: string | null; ai_confidence?: number | string | null;
  break_even_moved?: boolean; trailing_activated_at?: string | null;
  partial_take_profit_pct?: number | null; ai_regime?: string | null;
}

function PositionCard({
  position: p, onClose, onMoveStop, onReduce, onAdd,
}: {
  position: PosRow;
  onClose: () => void;
  onMoveStop: (n: number) => void;
  onReduce: (q: number) => void;
  onAdd: (q: number) => void;
}) {
  const [manage, setManage] = useState<null | "stop" | "reduce" | "add">(null);
  const [val, setVal] = useState("");

  const dir = p.side === "long" ? 1 : -1;
  const pnl = p.currentPrice != null
    ? (Number(p.currentPrice) - Number(p.avg_entry)) * dir * Number(p.qty)
    : 0;
  const pnlPct = p.currentPrice != null
    ? ((Number(p.currentPrice) - Number(p.avg_entry)) / Number(p.avg_entry)) * 100 * dir
    : 0;
  const r = p.stop_loss ? Math.abs(Number(p.avg_entry) - Number(p.stop_loss)) : 0;
  const rMultiple = r > 0 && p.currentPrice != null
    ? ((Number(p.currentPrice) - Number(p.avg_entry)) * dir) / r : 0;

  function submitManage() {
    const n = Number(val);
    if (!n || n <= 0) { toast.error("Enter a valid number"); return; }
    if (manage === "stop") onMoveStop(n);
    else if (manage === "reduce") onReduce(n);
    else if (manage === "add") onAdd(n);
    setManage(null); setVal("");
  }

  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold font-mono">{p.symbol}</span>
        <span className={`text-xs font-mono uppercase px-1.5 py-0.5 rounded ${
          p.side === "long" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
        }`}>{p.side}</span>
        {p.break_even_moved && (
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-primary/15 text-primary" title="Stop moved to break-even">
            BE
          </span>
        )}
        {p.trailing_activated_at && (
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-primary/15 text-primary" title="Trailing stop active">
            trailing
          </span>
        )}
        {p.partial_take_profit_pct && (
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-success/15 text-success" title="Partial TP taken">
            partial TP
          </span>
        )}
        <div className="ml-auto text-xs text-muted-foreground font-mono">
          Opened {new Date(p.opened_at).toLocaleString()}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 md:grid-cols-7 gap-3 text-sm">
        <Cell k="Qty" v={fmtNum(p.qty, 6)} />
        <Cell k="Entry" v={fmtUsd(p.avg_entry)} />
        <Cell k="Mark" v={p.currentPrice != null ? fmtUsd(p.currentPrice) : "—"} />
        <Cell k="Stop" v={p.stop_loss ? fmtUsd(p.stop_loss) : "—"} />
        <Cell k="Target" v={p.take_profit ? fmtUsd(p.take_profit) : "—"} />
        <Cell k="R-mult" v={r > 0 ? rMultiple.toFixed(2) + "R" : "—"} />
        <Cell k="Unrealized" v={<span className={pnl >= 0 ? "text-success" : "text-destructive"}>
          {fmtUsd(pnl)} <span className="text-xs opacity-70">({pnlPct.toFixed(2)}%)</span>
        </span>} />
      </div>

      {manage && (
        <div className="mt-4 p-3 rounded-md border border-primary/40 bg-primary/5">
          <div className="text-[10px] uppercase font-mono text-primary mb-2">
            {manage === "stop" && "Move stop loss to price"}
            {manage === "reduce" && "Reduce position by qty"}
            {manage === "add" && "Add qty to position"}
          </div>
          <div className="flex gap-2">
            <input
              type="number" step="0.00000001" value={val} onChange={e => setVal(e.target.value)}
              className="flex-1 px-3 py-2 rounded-md bg-input border border-border font-mono text-sm"
              placeholder={manage === "stop" ? "New stop price" : "Quantity"}
            />
            <button onClick={submitManage}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
              Apply
            </button>
            <button onClick={() => { setManage(null); setVal(""); }}
              className="rounded-md border border-border px-3 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => { setManage("stop"); setVal(p.stop_loss ? String(p.stop_loss) : ""); }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">
          <Shield className="w-3.5 h-3.5" /> Move stop
        </button>
        <button onClick={() => { setManage("reduce"); setVal(String(Number(p.qty) / 2)); }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">
          <TrendingDown className="w-3.5 h-3.5" /> Reduce
        </button>
        <button onClick={() => { setManage("add"); setVal(String(Number(p.qty) * 0.5)); }}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">
          <Plus className="w-3.5 h-3.5" /> Add
        </button>
        <button onClick={onClose}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-destructive hover:text-destructive-foreground hover:border-destructive">
          <CloseIcon className="w-3.5 h-3.5" /> Close position
        </button>
      </div>

      {p.ai_reasoning && (
        <div className="mt-4 p-3 rounded-md border border-border bg-secondary/30 text-sm">
          <div className="text-[10px] uppercase font-mono text-muted-foreground mb-1">
            AI reasoning · confidence {((Number(p.ai_confidence ?? 0)) * 100).toFixed(0)}%
            {p.ai_regime && ` · ${p.ai_regime.replace(/_/g, " ")}`}
          </div>
          <p className="text-muted-foreground italic">&ldquo;{p.ai_reasoning}&rdquo;</p>
        </div>
      )}
    </div>
  );
}

function Cell({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-mono text-muted-foreground">{k}</div>
      <div className="font-mono">{v}</div>
    </div>
  );
}
