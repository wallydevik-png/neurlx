import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd, fmtNum } from "@/components/AppShell";
import { getAuditLog, listOrders, listPositions } from "@/lib/trading.functions";

export const Route = createFileRoute("/_authenticated/history")({
  head: () => ({ meta: [{ title: "History — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: History,
});

function History() {
  const ordersFn = useServerFn(listOrders);
  const posFn = useServerFn(listPositions);
  const auditFn = useServerFn(getAuditLog);
  const { data: orders = [] } = useQuery({ queryKey: ["orders"], queryFn: () => ordersFn() });
  const { data: positions = [] } = useQuery({ queryKey: ["positions"], queryFn: () => posFn() });
  const { data: audit = [] } = useQuery({ queryKey: ["audit"], queryFn: () => auditFn() });
  const closed = positions.filter(p => p.status === "closed");

  return (
    <AppShell>
      <PageHeader title="History & Audit" subtitle="Complete trade journal, order book, and immutable audit log." />

      <section>
        <h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Closed positions ({closed.length})</h2>
        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground bg-secondary/40">
              <tr>
                <Th>Closed</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th><Th>Entry</Th><Th>Exit</Th><Th>P&L</Th><Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {closed.length === 0 ? (
                <tr><td colSpan={8} className="text-center text-muted-foreground p-6">No closed trades yet.</td></tr>
              ) : closed.map(p => (
                <tr key={p.id} className="border-t border-border">
                  <Td className="text-muted-foreground">{p.closed_at ? new Date(p.closed_at).toLocaleString() : "—"}</Td>
                  <Td className="font-mono">{p.symbol}</Td>
                  <Td className="font-mono uppercase">{p.side}</Td>
                  <Td className="font-mono">{fmtNum(p.qty, 6)}</Td>
                  <Td className="font-mono">{fmtUsd(p.avg_entry)}</Td>
                  <Td className="font-mono">{fmtUsd(p.exit_price)}</Td>
                  <Td className={`font-mono ${Number(p.realized_pnl) >= 0 ? "text-success" : "text-destructive"}`}>
                    {fmtUsd(p.realized_pnl)}
                  </Td>
                  <Td className="text-xs text-muted-foreground">{p.exit_reason}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Order book ({orders.length})</h2>
        <div className="panel overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-[10px] font-mono uppercase text-muted-foreground bg-secondary/40">
              <tr>
                <Th>Time</Th><Th>Symbol</Th><Th>Side</Th><Th>Qty</Th><Th>Fill</Th><Th>Fees</Th><Th>Slip (bps)</Th><Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr><td colSpan={8} className="text-center text-muted-foreground p-6">No orders yet.</td></tr>
              ) : orders.slice(0, 50).map(o => (
                <tr key={o.id} className="border-t border-border">
                  <Td className="text-muted-foreground">{new Date(o.created_at).toLocaleString()}</Td>
                  <Td className="font-mono">{o.symbol}</Td>
                  <Td className="font-mono uppercase">{o.side}</Td>
                  <Td className="font-mono">{fmtNum(o.qty, 6)}</Td>
                  <Td className="font-mono">{o.filled_price ? fmtUsd(o.filled_price) : "—"}</Td>
                  <Td className="font-mono">{fmtUsd(o.fees)}</Td>
                  <Td className="font-mono">{fmtNum(o.slippage_bps, 2)}</Td>
                  <Td className="font-mono text-xs uppercase">{o.status}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-mono uppercase text-muted-foreground mb-3">Audit log ({audit.length})</h2>
        <div className="panel p-4 max-h-96 overflow-auto">
          <div className="space-y-2 text-xs font-mono">
            {audit.length === 0 ? (
              <div className="text-muted-foreground p-4 text-center">No audit entries.</div>
            ) : audit.map(a => (
              <div key={a.id} className="flex gap-3 items-baseline border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground shrink-0">{new Date(a.created_at).toISOString()}</span>
                <span className="text-primary shrink-0">{a.action}</span>
                <span className="text-muted-foreground truncate">{a.entity ?? ""}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    </AppShell>
  );
}

function Th({ children }: { children: React.ReactNode }) { return <th className="text-left px-4 py-2 font-medium">{children}</th>; }
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <td className={"px-4 py-2 " + className}>{children}</td>;
}
