import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import {
  getMyCompliance, recordConsent, exportMyData,
  requestAccountDeletion, cancelDeletionRequest,
} from "@/lib/compliance.functions";
import { AlertTriangle, Download, Trash2, ShieldCheck, FileText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/compliance")({
  head: () => ({ meta: [{ title: "Compliance & Data — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Compliance,
});

function Compliance() {
  const fetchFn = useServerFn(getMyCompliance);
  const recordFn = useServerFn(recordConsent);
  const exportFn = useServerFn(exportMyData);
  const deleteFn = useServerFn(requestAccountDeletion);
  const cancelFn = useServerFn(cancelDeletionRequest);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["compliance"], queryFn: () => fetchFn() });
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);

  const consents = data?.consents;
  const versions = data?.versions;
  const tosOk = !!consents?.tos_accepted_at && consents.tos_version === versions?.tos;
  const privOk = !!consents?.privacy_accepted_at && consents.privacy_version === versions?.privacy;
  const riskOk = !!consents?.risk_accepted_at && consents.risk_version === versions?.risk;

  async function accept(kind: "tos" | "privacy" | "risk") {
    try {
      await recordFn({ data: { [kind]: true } as never });
      toast.success("Consent recorded");
      qc.invalidateQueries({ queryKey: ["compliance"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function toggleMarketing(v: boolean) {
    try {
      await recordFn({ data: { marketing_opt_in: v } });
      qc.invalidateQueries({ queryKey: ["compliance"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function doExport() {
    setBusy(true);
    try {
      const res = await exportFn();
      const blob = new Blob([res.bundleJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `neurlx-data-export-${new Date().toISOString().slice(0,10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      toast.success("Data export downloaded");
      qc.invalidateQueries({ queryKey: ["compliance"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Export failed"); }
    finally { setBusy(false); }
  }

  async function doDelete() {
    if (phrase !== "DELETE MY ACCOUNT") { toast.error("Type the confirmation phrase exactly."); return; }
    setBusy(true);
    try {
      await deleteFn({ data: { confirmPhrase: phrase } });
      toast.success("Deletion requested — 30 day grace period. Kill switch activated.");
      setPhrase("");
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }
  async function doCancel() {
    setBusy(true);
    try {
      await cancelFn();
      toast.success("Deletion cancelled");
      qc.invalidateQueries({ queryKey: ["compliance"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }

  if (isLoading) return <AppShell><div className="text-muted-foreground">Loading…</div></AppShell>;

  return (
    <AppShell>
      <PageHeader title="Compliance & Data" subtitle="Consent, disclosures, and your GDPR/CCPA rights." />

      <div className="panel p-5 mb-4 border-l-2 border-warning">
        <div className="flex gap-3">
          <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
          <div className="text-sm">
            <div className="font-medium mb-1">Risk Disclosure</div>
            <p className="text-muted-foreground">
              Trading crypto and other leveraged assets carries a substantial risk of loss and is not suitable for every investor.
              Past performance — including backtests, paper trades, and shadow-mode results — is not indicative of future results.
              AI signals are probabilistic and can be wrong. You are solely responsible for trades executed on your connected accounts.
              Never trade with funds you cannot afford to lose. This platform is a tool, not financial advice.
            </p>
          </div>
        </div>
      </div>

      <section className="panel p-5 mb-4">
        <h2 className="font-semibold mb-3 flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary"/>Consent Ledger</h2>
        <div className="grid gap-3">
          <ConsentRow ok={tosOk} label="Terms of Service" version={versions?.tos} onAccept={() => accept("tos")}
            acceptedAt={consents?.tos_accepted_at} />
          <ConsentRow ok={privOk} label="Privacy Policy (GDPR/CCPA)" version={versions?.privacy} onAccept={() => accept("privacy")}
            acceptedAt={consents?.privacy_accepted_at} />
          <ConsentRow ok={riskOk} label="Risk Disclosure" version={versions?.risk} onAccept={() => accept("risk")}
            acceptedAt={consents?.risk_accepted_at} />
        </div>
        <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
          <div className="text-sm">
            <div className="font-medium">Marketing communications</div>
            <div className="text-xs text-muted-foreground">Occasional product updates. You can opt out anytime.</div>
          </div>
          <button
            onClick={() => toggleMarketing(!consents?.marketing_opt_in)}
            className={`w-10 h-6 rounded-full transition relative shrink-0 ${consents?.marketing_opt_in ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-background transition ${consents?.marketing_opt_in ? "left-[18px]" : "left-0.5"}`} />
          </button>
        </div>
      </section>

      <section className="panel p-5 mb-4">
        <h2 className="font-semibold mb-3 flex items-center gap-2"><Download className="h-4 w-4 text-primary"/>Export Your Data</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Download a complete JSON archive of your profile, trades, journals, signals, notifications, audit log, and settings.
          Encrypted API credentials are redacted.
        </p>
        <button onClick={doExport} disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
          <Download className="h-4 w-4" /> Download data archive
        </button>
      </section>

      <section className="panel p-5 mb-4 border-l-2 border-destructive/60">
        <h2 className="font-semibold mb-3 flex items-center gap-2 text-destructive"><Trash2 className="h-4 w-4"/>Delete Account</h2>
        {data?.deletionRequestedAt ? (
          <div>
            <div className="text-sm mb-3">
              Deletion requested on <span className="font-mono">{new Date(data.deletionRequestedAt).toLocaleString()}</span>.
              Your automation is halted and trading permissions are revoked. Data will be permanently purged after a 30-day grace period.
            </div>
            <button onClick={doCancel} disabled={busy}
              className="px-4 py-2 rounded-md border border-border text-sm">Cancel deletion request</button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground mb-3">
              This immediately activates the kill switch, revokes all trading permissions, and schedules permanent purge of your
              data after a 30-day grace period. Type <code className="font-mono text-foreground">DELETE MY ACCOUNT</code> to confirm.
            </p>
            <div className="flex gap-2">
              <input value={phrase} onChange={e => setPhrase(e.target.value)}
                placeholder="DELETE MY ACCOUNT"
                className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-sm font-mono" />
              <button onClick={doDelete} disabled={busy || phrase !== "DELETE MY ACCOUNT"}
                className="px-4 py-2 rounded-md bg-destructive text-destructive-foreground text-sm font-medium disabled:opacity-40">
                Request deletion
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2"><FileText className="h-4 w-4 text-primary"/>Request History</h2>
        {(data?.requests?.length ?? 0) === 0 ? (
          <div className="text-sm text-muted-foreground">No requests yet.</div>
        ) : (
          <div className="divide-y divide-border">
            {data!.requests.map(r => (
              <div key={r.id} className="py-2 flex items-center justify-between text-sm">
                <div>
                  <span className="uppercase text-xs font-mono mr-2 text-muted-foreground">{r.kind}</span>
                  <span>{new Date(r.requested_at).toLocaleString()}</span>
                </div>
                <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded ${
                  r.status === "completed" ? "bg-success/15 text-success"
                  : r.status === "cancelled" ? "bg-muted text-muted-foreground"
                  : "bg-warning/15 text-warning"
                }`}>{r.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </AppShell>
  );
}

function ConsentRow({ ok, label, version, acceptedAt, onAccept }: {
  ok: boolean; label: string; version?: string; acceptedAt?: string | null; onAccept: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 p-3 rounded-md border border-border bg-secondary/30">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground font-mono">
          version {version} {ok && acceptedAt ? `· accepted ${new Date(acceptedAt).toLocaleDateString()}` : ""}
        </div>
      </div>
      {ok ? (
        <span className="text-xs font-mono uppercase px-2 py-1 rounded bg-success/15 text-success">Accepted</span>
      ) : (
        <button onClick={onAccept} className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium">
          I agree
        </button>
      )}
    </div>
  );
}
