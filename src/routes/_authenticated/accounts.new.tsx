import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import {
  BROKER_CATEGORIES, brokersByCategory, getBroker,
  type BrokerCategory, type BrokerDescriptor,
} from "@/lib/connectors/brokerRegistry";
import { addConnection } from "@/lib/trading.functions";
import { toast } from "sonner";
import { Lock, ArrowLeft, ExternalLink, ShieldCheck, KeyRound, Fingerprint, LogIn, Zap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/accounts/new")({
  head: () => ({ meta: [{ title: "Connect Trading Account — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: NewAccount,
});

function NewAccount() {
  const nav = useNavigate();
  const add = useServerFn(addConnection);

  const [category, setCategory] = useState<BrokerCategory | "paper">("paper");
  const [brokerId, setBrokerId] = useState<string>("paper");
  const [label, setLabel] = useState("Paper account");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [server, setServer] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const broker = useMemo<BrokerDescriptor>(() => getBroker(brokerId)!, [brokerId]);

  function selectBroker(b: BrokerDescriptor) {
    setBrokerId(b.id);
    setLabel(b.displayName);
    setCreds({});
    setServer(b.metatraderServers?.[0] ?? "");
    setAccountNumber("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (broker.authMethod === "oauth" && !broker.implemented) {
      toast.error(`${broker.displayName} OAuth flow is not yet wired. Coming soon.`);
      return;
    }
    // Client-side guard mirroring the server: never accept withdrawal-scoped keys.
    if (Object.keys(creds).some(k => k.toLowerCase().includes("withdraw"))) {
      toast.error("NeurlX never accepts withdrawal credentials.");
      return;
    }
    setBusy(true);
    try {
      await add({
        data: {
          connectorId: broker.id,
          label,
          credentials: creds,
          tradingEnabled: broker.id === "paper",
          brokerCategory: broker.category === "crypto" && broker.id === "paper" ? undefined : broker.category,
          authMethod: broker.authMethod,
          brokerServer: server || undefined,
          accountNumber: accountNumber || undefined,
        },
      });
      toast.success(broker.implemented ? "Connected" : `${broker.displayName} added — awaiting first-class connector.`);
      nav({ to: "/accounts" });
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : "Connection failed. Please check the key fields and try again.";
      toast.error(message === "Failed" ? "Connection failed. Please check the key fields and try again." : message);
    } finally { setBusy(false); }
  }

  return (
    <AppShell>
      <button onClick={() => nav({ to: "/accounts" })}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" /> Back to accounts
      </button>
      <PageHeader
        title="Connect Trading Account"
        subtitle="Universal Broker Hub — every provider connects through its officially supported flow. NeurlX never scrapes broker websites or automates logins."
      />

      {/* Category tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {BROKER_CATEGORIES.map(c => (
          <button key={c.id} onClick={() => setCategory(c.id)}
            className={`px-3 py-1.5 rounded-md text-sm border transition ${
              category === c.id
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-secondary/40 border-border hover:border-primary/50"
            }`}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Provider grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
        {brokersByCategory(category).map(b => (
          <button key={b.id} type="button" onClick={() => selectBroker(b)}
            className={`text-left panel p-4 transition ${
              brokerId === b.id ? "!border-primary ring-1 ring-primary" : "hover:!border-border"
            }`}>
            <div className="flex justify-between items-start gap-2">
              <div className="font-semibold">{b.displayName}</div>
              <AuthBadge method={b.authMethod} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{b.description}</p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              {b.implemented
                ? <span className="text-[10px] font-mono uppercase text-success">Live</span>
                : <span className="text-[10px] font-mono uppercase text-muted-foreground">Registered · stub</span>}
              {b.assetClasses.slice(0, 3).map(a => (
                <span key={a} className="text-[10px] font-mono uppercase text-muted-foreground border border-border rounded px-1.5 py-0.5">
                  {a.replace("_", " ")}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {/* Dynamic auth form */}
      <form onSubmit={submit} className="panel p-6 max-w-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold">Configure {broker.displayName}</h2>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{broker.authNote}</p>
          </div>
          <AuthBadge method={broker.authMethod} large />
        </div>

        {broker.docsUrl && (
          <a href={broker.docsUrl} target="_blank" rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
            Official {broker.displayName} docs <ExternalLink className="w-3 h-3" />
          </a>
        )}

        <div className="mt-5 space-y-4">
          <Field label="Label" hint="A friendly name to identify this account.">
            <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={80}
              className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </Field>

          {/* Paper */}
          {broker.authMethod === "paper" && (
            <div className="text-sm text-muted-foreground bg-secondary/40 border border-border rounded-md p-3">
              Paper accounts start with $100,000 in simulated cash. Fills, fees, and slippage are modeled realistically.
            </div>
          )}

          {/* OAuth */}
          {broker.authMethod === "oauth" && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <LogIn className="w-4 h-4 text-primary" />
                Official {broker.displayName} OAuth
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                You'll be redirected to {broker.displayName} to approve read + trade scopes. Withdrawal scope is never requested. NeurlX stores only an encrypted refresh token.
              </p>
              <button type="button" disabled
                className="rounded-md bg-primary/70 px-4 py-2 text-sm font-medium text-primary-foreground opacity-60 cursor-not-allowed">
                Continue to {broker.displayName} — coming soon
              </button>
              <p className="text-[11px] text-muted-foreground">
                Saving now creates a placeholder connection so the account shows in your dashboard when the OAuth exchange is wired.
              </p>
            </div>
          )}

          {/* API key */}
          {broker.authMethod === "api_key" && (
            <>
              <WithdrawalWarning />
              {broker.credentialFields?.map(f => (
                <Field key={f.key} label={f.label} hint={f.helper}>
                  <input type={f.secret ? "password" : "text"} placeholder={f.placeholder}
                    value={creds[f.key] ?? ""} onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
                    className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
                </Field>
              ))}
            </>
          )}

          {/* MetaTrader */}
          {broker.authMethod === "metatrader" && (
            <>
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground flex gap-2">
                <Fingerprint className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
                <div>
                  NeurlX connects through the official {broker.id === "mt4" ? "MetaTrader 4" : "MetaTrader 5"} gateway.
                  Use the <b>investor password</b> for read-only, or the <b>trading password</b> to allow order placement.
                  Your website / broker portal password is never requested.
                </div>
              </div>
              <Field label="MT Login (account number)">
                <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)}
                  placeholder="e.g. 51234567"
                  className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
              </Field>
              <Field label="MT Password" hint="Investor password = read only. Trading password = orders enabled.">
                <input type="password" value={creds.password ?? ""}
                  onChange={e => setCreds({ ...creds, password: e.target.value })}
                  className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
              </Field>
              <Field label="Broker Server" hint="Shown in your MT terminal under File → Login to Trade Account.">
                {broker.metatraderServers?.length ? (
                  <select value={server} onChange={e => setServer(e.target.value)}
                    className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary">
                    {broker.metatraderServers.map(s => <option key={s} value={s}>{s}</option>)}
                    <option value="">Other — type below</option>
                  </select>
                ) : (
                  <input value={server} onChange={e => setServer(e.target.value)}
                    placeholder="e.g. ICMarketsSC-Live22"
                    className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
                )}
              </Field>
            </>
          )}

          {/* SDK */}
          {broker.authMethod === "sdk" && (
            <>
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs text-muted-foreground flex gap-2">
                <Zap className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
                <div>
                  {broker.displayName} authenticates through its official SDK / gateway. You log in directly with {broker.displayName} — NeurlX never sees your password. Provide the gateway address and account below.
                </div>
              </div>
              {broker.credentialFields?.map(f => (
                <Field key={f.key} label={f.label} hint={f.helper}>
                  <input type={f.secret ? "password" : "text"} placeholder={f.placeholder}
                    value={creds[f.key] ?? ""} onChange={e => setCreds({ ...creds, [f.key]: e.target.value })}
                    className="w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
                </Field>
              ))}
            </>
          )}
        </div>

        <button disabled={busy || (broker.authMethod === "oauth" && !broker.implemented)} type="submit"
          className="mt-6 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? "Connecting…" : broker.implemented ? "Connect account" : "Save placeholder connection"}
        </button>
      </form>
    </AppShell>
  );
}

function WithdrawalWarning() {
  return (
    <div className="text-xs bg-destructive/10 border border-destructive/40 text-destructive rounded-md p-3 flex gap-2">
      <Lock className="w-4 h-4 shrink-0 mt-0.5" />
      <div>
        <b>Withdrawal permission is forbidden.</b> NeurlX auto-rejects any API key with the withdraw scope enabled — even if you save it, the first health scan will detect and revoke it. Generate the key with Read + Trade only.
      </div>
    </div>
  );
}

function AuthBadge({ method, large }: { method: string; large?: boolean }) {
  const styles: Record<string, { label: string; icon: React.ElementType; cls: string }> = {
    oauth:      { label: "OAuth",       icon: LogIn,       cls: "text-primary border-primary/40" },
    api_key:    { label: "API Key",     icon: KeyRound,    cls: "text-warning border-warning/40" },
    metatrader: { label: "MetaTrader",  icon: Fingerprint, cls: "text-primary border-primary/40" },
    sdk:        { label: "Official SDK",icon: Zap,         cls: "text-primary border-primary/40" },
    paper:      { label: "Simulated",   icon: ShieldCheck, cls: "text-success border-success/40" },
  };
  const s = styles[method] ?? styles.api_key;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 border rounded px-1.5 py-0.5 font-mono uppercase ${s.cls} ${large ? "text-xs" : "text-[10px]"}`}>
      <Icon className={large ? "w-3.5 h-3.5" : "w-3 h-3"} /> {s.label}
    </span>
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
