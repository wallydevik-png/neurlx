import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import { usePWA } from "@/hooks/usePWA";
import { useBiometric } from "@/hooks/useBiometric";
import { listCredentials, removeCredential } from "@/lib/webauthn.functions";
import {
  Smartphone, Download, WifiOff, Wifi, Bell, Fingerprint, Trash2, ShieldCheck,
  RefreshCw, Info,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/mobile")({
  head: () => ({ meta: [{ title: "Mobile & Security — Helix" }, { name: "robots", content: "noindex" }] }),
  component: Mobile,
});

function Mobile() {
  const { isInstalled, isOnline, supportsPush, install, installPrompt } = usePWA();
  const { register, authenticate, busy, error, isSupported } = useBiometric();
  const fetchCreds = useServerFn(listCredentials);
  const removeFn = useServerFn(removeCredential);
  const qc = useQueryClient();
  const { data: credentials, isLoading } = useQuery({
    queryKey: ["biometric-creds"],
    queryFn: () => fetchCreds(),
  });
  const [nickname, setNickname] = useState("");

  async function addCredential() {
    try {
      await register(nickname || "This device");
      toast.success("Biometric credential registered");
      qc.invalidateQueries({ queryKey: ["biometric-creds"] });
      setNickname("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Registration failed");
    }
  }

  async function remove(id: string) {
    try {
      await removeFn({ data: { id } });
      toast.success("Credential removed");
      qc.invalidateQueries({ queryKey: ["biometric-creds"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  async function testAuth() {
    try {
      await authenticate();
      toast.success("Biometric verification succeeded");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Verification failed");
    }
  }

  return (
    <AppShell>
      <PageHeader
        title="Mobile & Security"
        subtitle="PWA install, biometric authentication, and offline status."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-5">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Progressive Web App
          </h2>
          <div className="grid gap-4">
            <div className="flex items-center justify-between p-3 rounded-md border border-border bg-secondary/30">
              <div className="flex items-center gap-2">
                {isInstalled ? <Download className="h-4 w-4 text-success" /> : <Info className="h-4 w-4 text-muted-foreground" />}
                <div className="text-sm">
                  <div className="font-medium">{isInstalled ? "Installed on device" : "Installable web app"}</div>
                  <div className="text-xs text-muted-foreground">{isInstalled ? "Helix is running as a standalone app" : "Add Helix to your home screen for quick access"}</div>
                </div>
              </div>
              <button
                onClick={install}
                disabled={!installPrompt || isInstalled}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium disabled:opacity-40"
              >
                {isInstalled ? "Installed" : "Install"}
              </button>
            </div>
            <div className="flex items-center justify-between p-3 rounded-md border border-border bg-secondary/30">
              <div className="flex items-center gap-2">
                {isOnline ? <Wifi className="h-4 w-4 text-success" /> : <WifiOff className="h-4 w-4 text-warning" />}
                <div className="text-sm">
                  <div className="font-medium">{isOnline ? "Online" : "Offline"}</div>
                  <div className="text-xs text-muted-foreground">{isOnline ? "Real-time data is available" : "Cached data only; actions queue when reconnected"}</div>
                </div>
              </div>
              <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded ${isOnline ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
                {isOnline ? "live" : "cached"}
              </span>
            </div>
            <div className="flex items-center justify-between p-3 rounded-md border border-border bg-secondary/30">
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-primary" />
                <div className="text-sm">
                  <div className="font-medium">Push notifications</div>
                  <div className="text-xs text-muted-foreground">{supportsPush ? "Supported by this browser" : "Not supported"}</div>
                </div>
              </div>
              <span className={`text-xs font-mono uppercase px-2 py-0.5 rounded ${supportsPush ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>
                {supportsPush ? "ready" : "n/a"}
              </span>
            </div>
          </div>
        </section>

        <section className="panel p-5">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <Fingerprint className="h-4 w-4 text-primary" /> Biometric Authentication
          </h2>
          <div className="text-sm text-muted-foreground mb-4">
            Register Face ID, Touch ID, or fingerprint to gate sensitive actions like deactivating the kill switch.
            {!isSupported && (
              <span className="block mt-2 text-warning">Your browser or device does not support WebAuthn.</span>
            )}
          </div>

          {credentials && credentials.length > 0 && (
            <div className="mb-4 divide-y divide-border border border-border rounded-md overflow-hidden">
              {credentials.map(c => (
                <div key={c.id} className="flex items-center justify-between p-3 bg-secondary/20">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{c.nickname || "Registered device"}</div>
                    <div className="text-[10px] font-mono text-muted- uppercase">
                      {c.device_type} · {c.backed_up ? "backed up" : "single-device"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {c.last_used_at ? `Last used ${new Date(c.last_used_at).toLocaleDateString()}` : "Never used"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={testAuth} className="p-2 rounded-md border border-border hover:bg-secondary/50" title="Test" aria-label="Test biometric">
                      <RefreshCw className="h-4 w-4" />
                    </button>
                    <button onClick={() => remove(c.id)} className="p-2 rounded-md border border-border hover:bg-destructive/10 text-destructive" title="Remove" aria-label="Remove credential">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {isLoading && <div className="text-sm text-muted-foreground">Loading credentials…</div>}

          {isSupported && (
            <div className="flex gap-2">
              <input
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                placeholder="Device nickname (optional)"
                className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-sm"
                maxLength={50}
              />
              <button
                onClick={addCredential}
                disabled={busy}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
              >
                Register
              </button>
            </div>
          )}
          {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
        </section>

        <section className="panel p-5 lg:col-span-2">
          <h2 className="font-semibold mb-4 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" /> Mobile Security Checklist
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <CheckItem ok={isInstalled} label="Installed as PWA" />
            <CheckItem ok={isOnline} label="Network online" />
            <CheckItem ok={supportsPush} label="Push notifications" />
            <CheckItem ok={(credentials?.length ?? 0) > 0} label="Biometric credential" />
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function CheckItem({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className={`flex items-center gap-2 p-3 rounded-md border text-sm ${ok ? "border-success/30 bg-success/10 text-success" : "border-border bg-secondary/30 text-muted-foreground"}`}>
      {ok ? <ShieldCheck className="h-4 w-4" /> : <Info className="h-4 w-4" />}
      <span>{label}</span>
    </div>
  );
}
