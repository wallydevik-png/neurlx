import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader, fmtUsd, fmtNum } from "@/components/AppShell";
import { listTradeJournal, listExecutionLog } from "@/lib/assistedLive.functions";
import { BookOpen, ScrollText } from "lucide-react";
import { useState } from "react";

export const Route = createFileRoute("/_authenticated/journal")({
  head: () => ({ meta: [{ title: "Trade Journal — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: JournalPage,
});

function JournalPage() {
  const fetchJournal = useServerFn(listTradeJournal);
  const fetchLog = useServerFn(listExecutionLog);
  const { data: journal = [] } = useQuery({ queryKey: ["journal"], queryFn: () => fetchJournal(), refetchInterval: 15000 });
  const { data: log = [] } = useQuery({ queryKey: ["exec-log"], queryFn: () => fetchLog(), refetchInterval: 10000 });
  const [tab, setTab] = useState<"journal" | "log">("journal");

  return (
    <AppShell>
      <PageHeader
        title="AI Trade Review"
        subtitle="Retrospective journal of every completed trade plus the immutable execution log."
      />

      <div className="flex gap-2 mb-4 border-b border-border">
        <TabBtn active={tab === "journal"} onClick={() => setTab("journal")} icon={BookOpen}>
          Journal ({journal.length})
        </TabBtn>
        <TabBtn active={tab === "log"} onClick={() => setTab("log")} icon={ScrollText}>
          Execution log ({log.length})
        </TabBtn>
      </div>

      {tab === "journal" ? (
        journal.length === 0 ? (
          <Empty msg="No completed trades yet. Approve a signal to build your journal." />
        ) : (
          <div className="space-y-3">
            {journal.map(j => <JournalCard key={j.id} entry={j} />)}
          </div>
        )
      ) : (
        log.length === 0 ? <Empty msg="No execution events yet." /> : (
          <div className="panel p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-[10px] uppercase font-mono text-muted-foreground bg-secondary/30">
                <tr>
                  <th className="text-left p-3">Time</th>
                  <th className="text-left p-3">Event</th>
                  <th className="text-left p-3">Message</th>
                </tr>
              </thead>
              <tbody>
                {log.map(e => (
                  <tr key={e.id} className="border-t border-border font-mono text-xs">
                    <td className="p-3 text-muted-foreground whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                    <td className={`p-3 ${
                      e.severity === "error" || e.severity === "critical" ? "text-destructive"
                        : e.severity === "warn" ? "text-warning" : "text-primary"
                    }`}>{e.event}</td>
                    <td className="p-3">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </AppShell>
  );
}

interface JournalRow {
  id: string; symbol: string; side: string;
  entry_reason: string | null; exit_reason: string | null;
  ai_confidence: number | string | null; market_regime: string | null;
  entry_price: number | string | null; exit_price: number | string | null;
  qty: number | string | null; realized_pnl: number | string | null;
  fees_total: number | string | null;
  execution_quality_score: number | string | null;
  user_modifications: number; duration_seconds: number | null;
  lessons: string | null; model_version: string | null;
  created_at: string;
}

function JournalCard({ entry: j }: { entry: JournalRow }) {
  const pnl = Number(j.realized_pnl ?? 0);
  const dur = j.duration_seconds ? formatDuration(j.duration_seconds) : "—";
  return (
    <div className="panel p-5">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="font-mono font-semibold">{j.symbol}</span>
        <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
          j.side === "long" ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
        }`}>{j.side}</span>
        <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${
          j.exit_reason === "take_profit" ? "bg-success/15 text-success"
            : j.exit_reason === "stop_loss" ? "bg-destructive/15 text-destructive"
            : "bg-secondary text-muted-foreground"
        }`}>{j.exit_reason?.replace(/_/g, " ")}</span>
        {j.market_regime && (
          <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
            {j.market_regime.replace(/_/g, " ")}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground font-mono">
          {new Date(j.created_at).toLocaleString()}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
        <Cell k="Entry" v={fmtUsd(j.entry_price)} />
        <Cell k="Exit" v={fmtUsd(j.exit_price)} />
        <Cell k="Qty" v={fmtNum(j.qty, 6)} />
        <Cell k="Realized" v={<span className={pnl >= 0 ? "text-success" : "text-destructive"}>{fmtUsd(pnl)}</span>} />
        <Cell k="Fees" v={fmtUsd(j.fees_total)} />
        <Cell k="Duration" v={dur} />
        <Cell k="AI conf." v={j.ai_confidence != null ? (Number(j.ai_confidence) * 100).toFixed(0) + "%" : "—"} />
        <Cell k="Exec quality" v={j.execution_quality_score != null ? Number(j.execution_quality_score).toFixed(1) + "/10" : "—"} />
        <Cell k="User mods" v={String(j.user_modifications)} />
        <Cell k="Model" v={j.model_version ?? "—"} />
      </div>

      {j.entry_reason && (
        <div className="mt-3 text-xs">
          <span className="text-[10px] uppercase font-mono text-muted-foreground">Why entered:</span>{" "}
          <span className="italic text-muted-foreground">&ldquo;{j.entry_reason}&rdquo;</span>
        </div>
      )}
      {j.lessons && (
        <div className="mt-2 p-3 rounded-md border border-primary/30 bg-primary/5 text-xs">
          <div className="text-[10px] uppercase font-mono text-primary mb-1">Lessons</div>
          {j.lessons}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children, icon: Icon }: {
  active: boolean; onClick: () => void; children: React.ReactNode; icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
        active ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}>
      <Icon className="w-4 h-4" /> {children}
    </button>
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

function Empty({ msg }: { msg: string }) {
  return <div className="panel p-10 text-center text-muted-foreground text-sm">{msg}</div>;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
