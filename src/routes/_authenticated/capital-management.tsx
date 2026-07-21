import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric, fmtUsd } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  addLedgerEntry, deleteLedgerEntry, getCapitalOverview, savePolicy, setAllocations,
} from "@/lib/capitalMgmt.functions";
import { useState } from "react";
import { toast } from "sonner";
import { Trash2, Plus, TrendingUp, TrendingDown, Minus, Banknote } from "lucide-react";

export const Route = createFileRoute("/_authenticated/capital-management")({
  head: () => ({ meta: [{ title: "Capital Management — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: CapitalMgmtPage,
});

type Alloc = { bucket: string; target_pct: number; notes?: string };

function CapitalMgmtPage() {
  const overviewFn = useServerFn(getCapitalOverview);
  const addFn = useServerFn(addLedgerEntry);
  const delFn = useServerFn(deleteLedgerEntry);
  const allocFn = useServerFn(setAllocations);
  const policyFn = useServerFn(savePolicy);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["capital-mgmt"], queryFn: () => overviewFn() });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["capital-mgmt"] });

  const addMut = useMutation({
    mutationFn: (payload: any) => addFn({ data: payload }),
    onSuccess: () => { toast.success("Entry added"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMut = useMutation({
    mutationFn: (id: string) => delFn({ data: { id } }),
    onSuccess: () => { toast.success("Removed"); invalidate(); },
  });
  const allocMut = useMutation({
    mutationFn: (allocations: Alloc[]) => allocFn({ data: { allocations } }),
    onSuccess: (r) => { toast.success(`Saved (${r.total.toFixed(0)}% allocated)`); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const policyMut = useMutation({
    mutationFn: (p: any) => policyFn({ data: p }),
    onSuccess: () => { toast.success("Policy saved"); invalidate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading capital…</div></AppShell>;

  const t = data.totals;
  const scaleColor = data.scaleSuggestion.action === "scale_up" ? "text-emerald-500"
    : data.scaleSuggestion.action === "scale_down" ? "text-red-500" : "text-muted-foreground";
  const ScaleIcon = data.scaleSuggestion.action === "scale_up" ? TrendingUp
    : data.scaleSuggestion.action === "scale_down" ? TrendingDown : Minus;

  return (
    <AppShell>
      <PageHeader
        title="Capital Management"
        subtitle="Deposits, withdrawals, allocations, reserves, and compounding rules."
      />

      <div className="grid gap-4 md:grid-cols-4">
        <Metric label="Net Contributed" value={fmtUsd(t.netContributed)} />
        <Metric label="Total P&L (net of fees)" value={fmtUsd(t.totalPnl)} tone={t.totalPnl >= 0 ? "pos" : "neg"} />
        <Metric label="Current Equity" value={fmtUsd(t.latestEquity)} />
        <Metric label="30-Snap Change" value={`${t.equityChangePct.toFixed(2)}%`} tone={t.equityChangePct >= 0 ? "pos" : "neg"} />
      </div>

      <Card className="mt-4 p-4">
        <div className="flex items-center gap-3">
          <ScaleIcon className={`h-5 w-5 ${scaleColor}`} />
          <div>
            <div className="text-sm font-semibold">
              Risk Scaling Suggestion:{" "}
              <span className={scaleColor}>
                {data.scaleSuggestion.action.replace("_", " ").toUpperCase()}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">{data.scaleSuggestion.reason}</div>
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3 text-sm">
          <div><span className="text-muted-foreground">Base Capital</span><div className="font-semibold">{fmtUsd(data.baseCapital)}</div></div>
          <div><span className="text-muted-foreground">Cash Reserve ({Number(data.policy.cash_reserve_pct).toFixed(0)}%)</span><div className="font-semibold">{fmtUsd(data.reserveUsd)}</div></div>
          <div><span className="text-muted-foreground">Deployable Capital</span><div className="font-semibold text-primary">{fmtUsd(data.deployableUsd)}</div></div>
        </div>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <PolicyCard policy={data.policy} onSave={(p) => policyMut.mutate(p)} pending={policyMut.isPending} />
        <AllocationCard
          initial={data.allocations}
          deployableUsd={data.deployableUsd}
          allocatedPct={data.allocatedPct}
          onSave={(a) => allocMut.mutate(a)}
          pending={allocMut.isPending}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <LedgerForm onAdd={(p) => addMut.mutate(p)} pending={addMut.isPending} />
        <LedgerList entries={data.ledger} onDelete={(id) => delMut.mutate(id)} />
      </div>
    </AppShell>
  );
}

function PolicyCard({ policy, onSave, pending }: { policy: any; onSave: (p: any) => void; pending: boolean }) {
  const [f, setF] = useState({
    cash_reserve_pct: Number(policy.cash_reserve_pct),
    compounding_mode: policy.compounding_mode as "reinvest" | "fixed" | "withdraw_profits",
    fixed_base_usd: Number(policy.fixed_base_usd),
    profit_withdraw_pct: Number(policy.profit_withdraw_pct),
    scale_up_threshold_pct: Number(policy.scale_up_threshold_pct),
    scale_down_drawdown_pct: Number(policy.scale_down_drawdown_pct),
  });
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold mb-3">Capital Policy</h3>
      <div className="space-y-3">
        <div>
          <Label>Compounding Mode</Label>
          <Select value={f.compounding_mode} onValueChange={(v: any) => setF({ ...f, compounding_mode: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="reinvest">Reinvest all profits</SelectItem>
              <SelectItem value="fixed">Fixed base capital</SelectItem>
              <SelectItem value="withdraw_profits">Withdraw % of profits</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Cash Reserve %" value={f.cash_reserve_pct} onChange={(v) => setF({ ...f, cash_reserve_pct: v })} />
          {f.compounding_mode === "fixed" && (
            <NumField label="Fixed Base (USD)" value={f.fixed_base_usd} onChange={(v) => setF({ ...f, fixed_base_usd: v })} />
          )}
          {f.compounding_mode === "withdraw_profits" && (
            <NumField label="Withdraw Profit %" value={f.profit_withdraw_pct} onChange={(v) => setF({ ...f, profit_withdraw_pct: v })} />
          )}
          <NumField label="Scale-up Threshold %" value={f.scale_up_threshold_pct} onChange={(v) => setF({ ...f, scale_up_threshold_pct: v })} />
          <NumField label="Scale-down DD %" value={f.scale_down_drawdown_pct} onChange={(v) => setF({ ...f, scale_down_drawdown_pct: v })} />
        </div>
        <Button className="w-full" onClick={() => onSave(f)} disabled={pending}>Save Policy</Button>
      </div>
    </Card>
  );
}

function AllocationCard({ initial, deployableUsd, allocatedPct, onSave, pending }: {
  initial: Array<{ bucket: string; target_pct: number; notes?: string | null; target_usd: number }>;
  deployableUsd: number; allocatedPct: number;
  onSave: (a: Alloc[]) => void; pending: boolean;
}) {
  const [rows, setRows] = useState<Alloc[]>(
    initial.length ? initial.map((a) => ({ bucket: a.bucket, target_pct: Number(a.target_pct), notes: a.notes ?? "" }))
      : [{ bucket: "Core Trend", target_pct: 40 }, { bucket: "Mean Reversion", target_pct: 30 }, { bucket: "Experimental", target_pct: 10 }]
  );
  const total = rows.reduce((s, r) => s + Number(r.target_pct || 0), 0);
  const over = total > 100.01;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Strategy Allocations</h3>
        <Badge variant={over ? "destructive" : "secondary"}>{total.toFixed(1)}% allocated</Badge>
      </div>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_90px_90px_auto] gap-2 items-center">
            <Input value={r.bucket} placeholder="Bucket" onChange={(e) => {
              const c = [...rows]; c[i] = { ...c[i], bucket: e.target.value }; setRows(c);
            }} />
            <Input type="number" step="0.1" value={r.target_pct} onChange={(e) => {
              const c = [...rows]; c[i] = { ...c[i], target_pct: Number(e.target.value) }; setRows(c);
            }} />
            <div className="text-xs text-muted-foreground text-right">{fmtUsd(deployableUsd * (Number(r.target_pct || 0) / 100))}</div>
            <Button size="icon" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex gap-2 mt-3">
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, { bucket: "New Bucket", target_pct: 0 }])}>
          <Plus className="h-4 w-4 mr-1" />Add
        </Button>
        <Button className="ml-auto" onClick={() => onSave(rows)} disabled={pending || over}>
          Save Allocations
        </Button>
      </div>
      {allocatedPct < 100 && (
        <div className="text-xs text-muted-foreground mt-2">
          {(100 - allocatedPct).toFixed(1)}% unallocated → treated as extra cash buffer.
        </div>
      )}
    </Card>
  );
}

function LedgerForm({ onAdd, pending }: { onAdd: (p: any) => void; pending: boolean }) {
  const [entry_type, setType] = useState<"deposit" | "withdrawal" | "fee" | "adjustment" | "realized_pnl">("deposit");
  const [amount, setAmount] = useState<number>(0);
  const [note, setNote] = useState("");
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold mb-3">Add Ledger Entry</h3>
      <div className="space-y-3">
        <div>
          <Label>Type</Label>
          <Select value={entry_type} onValueChange={(v: any) => setType(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="deposit">Deposit</SelectItem>
              <SelectItem value="withdrawal">Withdrawal</SelectItem>
              <SelectItem value="fee">Fee</SelectItem>
              <SelectItem value="adjustment">Adjustment</SelectItem>
              <SelectItem value="realized_pnl">Realized P&L</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <NumField label="Amount (USD)" value={amount} onChange={setAmount} />
        <div>
          <Label>Note</Label>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
        </div>
        <Button className="w-full" disabled={pending || !amount} onClick={() => {
          onAdd({ entry_type, amount_usd: amount, note: note || undefined });
          setAmount(0); setNote("");
        }}>Add Entry</Button>
      </div>
    </Card>
  );
}

function LedgerList({ entries, onDelete }: { entries: any[]; onDelete: (id: string) => void }) {
  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold mb-3">Recent Ledger ({entries.length})</h3>
      <div className="max-h-[400px] overflow-y-auto divide-y divide-border">
        {entries.length === 0 && <div className="text-sm text-muted-foreground">No entries yet.</div>}
        {entries.map((e) => (
          <div key={e.id} className="py-2 flex items-center gap-2 text-sm">
            <Badge variant="outline" className="text-xs">{e.entry_type}</Badge>
            <div className="flex-1 truncate">
              <div className="font-mono">{fmtUsd(Number(e.amount_usd))}</div>
              {e.note && <div className="text-xs text-muted-foreground truncate">{e.note}</div>}
            </div>
            <div className="text-xs text-muted-foreground">{new Date(e.occurred_at).toLocaleDateString()}</div>
            <Button size="icon" variant="ghost" onClick={() => onDelete(e.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input type="number" step="0.01" value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
