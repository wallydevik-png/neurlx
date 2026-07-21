import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import { CONNECTORS } from "@/lib/connectors/registry";
import { addConnection } from "@/lib/trading.functions";
import { toast } from "sonner";
import { Lock, ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/_authenticated/accounts/new")({
  head: () => ({ meta: [{ title: "Add Platform — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: NewAccount,
});

function NewAccount() {
  const nav = useNavigate();
  const add = useServerFn(addConnection);
  const [connectorId, setConnectorId] = useState<string>("paper");
  const [label, setLabel] = useState("Paper account");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const desc = CONNECTORS.find(c => c.id === connectorId)!;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await add({ data: { connectorId, label, credentials: creds, tradingEnabled: connectorId === "paper" } });
      toast.success("Connected");
      nav({ to: "/accounts" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally { setBusy(false); }
  }

  return (
    <AppShell>
      <button onClick={() => nav({ to: "/accounts" })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to accounts
      </button>
      <PageHeader title="Add trading platform" subtitle="Choose a platform and provide credentials. All secrets are encrypted at rest." />

      <div className="grid md:grid-cols-3 gap-3 mb-8">
        {CONNECTORS.map(c => (
          <button key={c.id} type="button" onClick={() => { setConnectorId(c.id); setLabel(c.displayName); setCreds({}); }}
            className={`text-left panel p-4 transition ${
              connectorId === c.id ? "!border-primary ring-1 ring-primary" : "hover:!border-border"
            }`}>
            <div className="flex justify-between items-start">
              <div className="font-semibold">{c.displayName}</div>
              <span className="text-[10px] font-mono uppercase text-muted-foreground">{c.authType}</span>
            </div>
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{c.description}</p>
            {!c.supportsRealTrading && (
              <div className="mt-3 text-[10px] font-mono text-primary">SIMULATED</div>
            )}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="panel p-6 max-w-xl">
        <h2 className="font-semibold">Configure {desc.displayName}</h2>
        <div className="mt-4 space-y-4">
          <Field label="Label"
            hint="A friendly name to identify this account.">
            <input value={label} onChange={e => setLabel(e.target.value)} required
              className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </Field>

          {desc.authType === "paper" && (
            <div className="text-sm text-muted-foreground bg-secondary/40 border border-border rounded-md p-3">
              Paper accounts start with $100,000 in simulated cash. Fills, fees, and slippage are modeled realistically.
            </div>
          )}

          {desc.authType === "api_key" && (
            <>
              <div className="text-xs text-muted-foreground bg-warning/10 border border-warning/30 text-warning-foreground rounded-md p-3 flex gap-2">
                <Lock className="w-4 h-4 shrink-0 mt-0.5 text-warning" />
                <div>
                  <b>Read-only recommended.</b> Live trading connectors are not enabled in this build — this connection will
                  be created in a disconnected state until the connector is available.
                </div>
              </div>
              {desc.credentialFields?.map(f => (
                <Field key={f.key} label={f.label}>
                  <input type={f.secret ? "password" : "text"} placeholder={f.placeholder}
                    value={creds[f.key] ?? ""} onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
                    className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
                </Field>
              ))}
            </>
          )}

          {desc.authType === "oauth" && (
            <div className="text-sm text-muted-foreground bg-secondary/40 border border-border rounded-md p-3">
              OAuth flows aren't wired in this build. This will save a placeholder connection so you can see how the flow appears.
            </div>
          )}
        </div>

        <button disabled={busy} type="submit"
          className="mt-6 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? "Connecting…" : "Connect account"}
        </button>
      </form>
    </AppShell>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-mono uppercase text-muted-foreground mb-1">{label}</div>
      {children}
      {hint && <div className="text-xs text-muted-foreground mt-1">{hint}</div>}
    </label>
  );
}
