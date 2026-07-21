import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import { disconnectConnection, listConnections, setPermissions } from "@/lib/trading.functions";
import { getConnectorDescriptor } from "@/lib/connectors/registry";
import { Plus, Trash2, Shield, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/accounts")({
  head: () => ({ meta: [{ title: "Connected Accounts — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Accounts,
});

function Accounts() {
  const fetchFn = useServerFn(listConnections);
  const disconnectFn = useServerFn(disconnectConnection);
  const permFn = useServerFn(setPermissions);
  const qc = useQueryClient();

  const { data: conns = [], isLoading } = useQuery({
    queryKey: ["connections"], queryFn: () => fetchFn(),
  });

  async function togglePerm(id: string, enabled: boolean) {
    try {
      await permFn({ data: { id, tradingEnabled: enabled } });
      toast.success(enabled ? "Trading permission enabled" : "Trading permission revoked");
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function disconnect(id: string) {
    if (!confirm("Disconnect this account? Credentials will be permanently wiped.")) return;
    try {
      await disconnectFn({ data: { id } });
      toast.success("Disconnected");
      qc.invalidateQueries({ queryKey: ["connections"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader
        title="Connected Accounts"
        subtitle="Add trading platforms, manage permissions, and monitor connection health."
        action={
          <Link to="/accounts/new" className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            <Plus className="w-4 h-4" /> Add trading platform
          </Link>
        }
      />

      {isLoading ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : conns.length === 0 ? (
        <div className="panel p-10 text-center">
          <Shield className="w-8 h-8 text-primary mx-auto" />
          <h2 className="mt-4 font-semibold">No accounts connected</h2>
          <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
            Start with a paper trading account. Add real exchanges later — they inherit the same modular connector interface.
          </p>
          <Link to="/accounts/new" className="mt-5 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
            <Plus className="w-4 h-4" /> Add first account
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {conns.map(c => {
            const desc = getConnectorDescriptor(c.connector_id);
            return (
              <div key={c.id} className="panel p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{c.label}</h3>
                      <span className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1.5 py-0.5">
                        {desc?.displayName ?? c.connector_id}
                      </span>
                      <span className={`text-[10px] font-mono uppercase rounded px-1.5 py-0.5 ${
                        c.status === "connected" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
                      }`}>{c.status}</span>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground font-mono">
                      Last sync: {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString() : "never"} · Health: {c.health}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link to="/accounts/$id/activate" params={{ id: c.id }}
                      className="text-xs px-3 py-1.5 rounded-md border border-primary/40 text-primary hover:bg-primary/10 font-medium whitespace-nowrap">
                      Manage live trading
                    </Link>
                    <button onClick={() => disconnect(c.id)}
                      className="p-2 rounded-md border border-border text-muted-foreground hover:text-destructive hover:border-destructive/40">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-4 grid md:grid-cols-2 gap-3 pt-4 border-t border-border">
                  <PermRow
                    label="Read access"
                    desc="View balances, market data, positions, and history."
                    on={c.read_enabled}
                    disabled
                    icon={<Shield className="w-4 h-4" />}
                  />
                  <PermRow
                    label="Trading permission"
                    desc="Allow AI or manual orders to be placed on this account."
                    on={c.trading_enabled}
                    icon={<ShieldCheck className="w-4 h-4" />}
                    onToggle={(v) => togglePerm(c.id, v)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}

function PermRow({ label, desc, on, disabled, icon, onToggle }: {
  label: string; desc: string; on: boolean; disabled?: boolean; icon: React.ReactNode;
  onToggle?: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 p-3 rounded-md border border-border bg-secondary/30">
      <div className="flex gap-2">
        <div className="text-primary mt-0.5">{icon}</div>
        <div>
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{desc}</div>
        </div>
      </div>
      <button
        disabled={disabled}
        onClick={() => onToggle?.(!on)}
        className={`w-10 h-6 rounded-full transition relative shrink-0 ${
          on ? "bg-primary" : "bg-muted"
        } ${disabled ? "opacity-50" : ""}`}
      >
        <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-background transition ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </div>
  );
}
