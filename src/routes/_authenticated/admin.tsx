import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell, PageHeader } from "@/components/AppShell";
import { getWalletVault, saveTradingWalletKey, removeTradingWalletKey } from "@/lib/memecoin.functions";
import { KeyRound, Lock, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Wallet Vault — NeurlX" },
      { name: "description", content: "Admin-only vault for the encrypted Solana trading key used by the memecoin sniper." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminVault,
});

function AdminVault() {
  const vaultFn = useServerFn(getWalletVault);
  const saveFn = useServerFn(saveTradingWalletKey);
  const removeFn = useServerFn(removeTradingWalletKey);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["wallet-vault"], queryFn: () => vaultFn() });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => qc.invalidateQueries({ queryKey: ["wallet-vault"] });

  async function save() {
    if (!secret.trim()) return;
    try {
      setBusy(true);
      const r = await saveFn({ data: { secretKey: secret } });
      setSecret("");
      toast.success(`Trading wallet stored: ${r.publicKey.slice(0, 6)}…${r.publicKey.slice(-4)}`);
      refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed to store key"); }
    finally { setBusy(false); }
  }

  async function remove() {
    try { setBusy(true); await removeFn(); toast.success("Key removed; auto-trading disabled"); refresh(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  }

  if (isLoading) {
    return <AppShell><div className="panel p-6 text-sm text-muted-foreground">Checking access…</div></AppShell>;
  }

  if (!data?.isAdmin) {
    return (
      <AppShell>
        <PageHeader title="Wallet Vault" subtitle="Restricted area." />
        <div className="panel p-8 mt-4 text-center">
          <Lock className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            This vault is restricted to platform administrators.
          </p>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Wallet Vault"
        subtitle="The Solana trading key used for unattended memecoin sniping. Encrypted with AES-256-GCM at rest and only decrypted server-side to sign a single transaction."
      />

      <section className="panel p-6 mt-4">
        <h2 className="font-semibold flex items-center gap-2"><KeyRound className="w-4 h-4" /> Trading wallet</h2>
        {data.wallet?.hasKey ? (
          <div className="mt-4 space-y-2 text-sm">
            <div className="font-mono break-all">{data.wallet.public_key}</div>
            <div className="text-xs text-muted-foreground font-mono">
              balance {data.sol != null ? `${data.sol.toFixed(4)} SOL` : "unavailable"} · key stored
            </div>
            <button onClick={remove} disabled={busy}
              className="mt-3 rounded-md border border-destructive/40 text-destructive px-4 py-2 text-sm disabled:opacity-60">
              Remove key & stop auto-trading
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No trading key stored. The sniper can scan but not execute.</p>
        )}
      </section>

      <section className="panel p-6 mt-4 mb-8">
        <h2 className="font-semibold">{data.wallet?.hasKey ? "Replace key" : "Add trading key"}</h2>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">
          In Phantom: Settings → Manage Accounts → your account → Show Private Key. Paste the base58 string
          (or a JSON byte array) below. Fund that wallet with only what you intend to trade.
        </p>
        <textarea value={secret} onChange={e => setSecret(e.target.value)} rows={3}
          placeholder="Base58 private key"
          className="mt-4 w-full rounded-md bg-input border border-border px-3 py-2 text-sm font-mono outline-none focus:border-primary" />
        <div className="mt-3 flex items-center gap-3">
          <button onClick={save} disabled={busy || !secret.trim()}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
            Encrypt & store
          </button>
          <span className="text-xs text-warning inline-flex items-center gap-1">
            <ShieldAlert className="w-3.5 h-3.5" /> Never share this key with anyone.
          </span>
        </div>
      </section>
    </AppShell>
  );
}
