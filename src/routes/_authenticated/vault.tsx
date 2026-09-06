import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import { getVault, requestWithdrawal, confirmWithdrawal, cancelWithdrawal } from "@/lib/vault.functions";
import { Button } from "@/components/ui/button";
import { Copy, ArrowDownToLine, ArrowUpFromLine, ShieldCheck, ExternalLink, RefreshCw } from "lucide-react";

export const Route = createFileRoute("/_authenticated/vault")({
  head: () => ({
    meta: [
      { title: "Trading Vault — NeurlX" },
      { name: "description", content: "Deposit Solana or USDC into your personal NeurlX trading wallet, track available versus reserved balance, and withdraw to any wallet you choose." },
      { property: "og:title", content: "Trading Vault — NeurlX" },
      { property: "og:description", content: "Fund the autonomous engine from your own dedicated on-chain wallet." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: VaultPage,
});

const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-6)}`;

function VaultPage() {
  const vaultFn = useServerFn(getVault);
  const requestFn = useServerFn(requestWithdrawal);
  const confirmFn = useServerFn(confirmWithdrawal);
  const cancelFn = useServerFn(cancelWithdrawal);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["vault"], queryFn: () => vaultFn(), refetchInterval: 30_000,
  });

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [asset, setAsset] = useState<"SOL" | "USDC">("SOL");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["vault"] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");

  const address = data?.wallet.address ?? "";
  const b = data?.balances;

  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    toast.success("Deposit address copied");
  }

  async function startWithdrawal() {
    try {
      setBusy("request");
      const res = await requestFn({ data: { asset, amount: Number(amount), destination: destination.trim() } });
      setPendingId(res.id);
      setSentTo(res.sentTo);
      toast.success(`Confirmation code emailed to ${res.sentTo} — enter it to release the funds`);
      refresh();
    } catch (e) { fail(e); } finally { setBusy(null); }
  }


  async function finishWithdrawal() {
    if (!pendingId) return;
    try {
      setBusy("confirm");
      const res = await confirmFn({ data: { id: pendingId, code } });
      toast.success(`Sent — ${res.signature.slice(0, 12)}…`);
      setPendingId(null); setCode(""); setAmount(""); setDestination("");
      refresh();
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  async function abandon() {
    if (!pendingId) return;
    try { await cancelFn({ data: { id: pendingId } }); } catch { /* already gone */ }
    setPendingId(null); setCode("");
    refresh();
  }

  return (
    <AppShell>
      <PageHeader
        title="Trading Vault"
        subtitle="Your own dedicated deposit address. Everything the autonomous engine trades comes from this balance — there is no other wallet to fund."
      />

      {isLoading || !data ? (
        <div className="text-sm text-muted-foreground">Loading your vault…</div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Available" value={b ? `${b.availableSol.toFixed(4)} SOL` : "—"} />
            <Metric label="Reserved" value={b ? `${(b.reservedSol + b.pendingSol).toFixed(4)} SOL` : "—"} />
            <Metric label="Total" value={b ? `${b.sol.toFixed(4)} SOL` : "—"} />
            <Metric label="USDC" value={b ? b.usdc.toFixed(2) : "—"} />
          </div>

          {b?.error && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              Balance unavailable: {b.error}
            </div>
          )}

          <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <ShieldCheck className="h-4 w-4" /> Autonomous trading
            </p>
            <p className="mt-1">
              Your autonomous engine trades using your available vault balance. Profits and losses stay
              in the vault until you withdraw. Reserved covers open positions and trades in flight, plus
              a small amount kept back for network fees. The signing key is created and encrypted on the
              server, is never shown in the browser, and can only move funds through a withdrawal you
              confirm by email.
            </p>
            {data.killSwitchActive && (
              <p className="mt-2 text-foreground">
                Emergency stop is active: no new trades will open, but withdrawals still work.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <Button variant={tab === "deposit" ? "default" : "outline"} onClick={() => setTab("deposit")}>
              <ArrowDownToLine className="mr-2 h-4 w-4" /> Deposit
            </Button>
            <Button variant={tab === "withdraw" ? "default" : "outline"} onClick={() => setTab("withdraw")}>
              <ArrowUpFromLine className="mr-2 h-4 w-4" /> Withdraw
            </Button>
            <Button variant="ghost" onClick={refresh} aria-label="Refresh balances">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {tab === "deposit" ? (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Send SOL or USDC to your NeurlX Vault address</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Send <strong>SOL</strong> or <strong>USDC</strong> on the Solana network from any exchange or
                wallet. Nothing else is supported — other chains or assets sent here may be lost. Funds
                become available for trading as soon as the network confirms them.
              </p>
              <div className="mt-3 flex flex-wrap items-start gap-4">
                {address && (
                  <div className="rounded-md bg-white p-2">
                    <QRCodeSVG value={address} size={132} />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 text-xs">{address}</code>
                  <Button size="sm" variant="outline" onClick={copyAddress}>
                    <Copy className="mr-2 h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Keep a little SOL here for network fees — around 0.003 SOL is held back automatically.
              </p>
            </section>

          ) : (
            <section className="rounded-lg border border-border bg-card p-4">
              <h2 className="text-sm font-semibold">Withdraw to any wallet</h2>
              {!pendingId ? (
                <div className="mt-3 space-y-3">
                  <div className="flex gap-2">
                    {(["SOL", "USDC"] as const).map(a => (
                      <Button key={a} size="sm" variant={asset === a ? "default" : "outline"} onClick={() => setAsset(a)}>
                        {a}
                      </Button>
                    ))}
                  </div>
                  <input
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    placeholder="Destination Solana address"
                    value={destination}
                    onChange={e => setDestination(e.target.value)}
                  />
                  <input
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                    placeholder={`Amount in ${asset}`}
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Withdrawable now: {asset === "SOL"
                      ? `${(b?.availableSol ?? 0).toFixed(4)} SOL`
                      : `${(b?.usdc ?? 0).toFixed(2)} USDC`}
                    {asset === "SOL" && b && b.reservedSol > 0
                      ? ` — ${b.reservedSol.toFixed(4)} SOL is locked in open positions.` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Daily limit: {asset === "SOL"
                      ? `${data.policy.remainingSol24h.toFixed(4)} of ${data.policy.dailyLimitSol} SOL left`
                      : `${data.policy.remainingUsdc24h.toFixed(2)} of ${data.policy.dailyLimitUsdc} USDC left`}
                    {" · "}New addresses unlock after {Math.round(data.policy.cooldownMinutes / 60)}h
                    {" · "}Code goes to {data.confirmation.sendTo ?? "your email"}
                  </p>
                  {!data.confirmation.configured && (
                    <p className="text-xs text-destructive">
                      Email delivery is not set up yet, so confirmation codes cannot be sent out-of-band
                      and withdrawals stay blocked. Set up the email domain to enable them.
                    </p>
                  )}
                  <Button
                    disabled={busy !== null || !amount || !destination}
                    onClick={startWithdrawal}
                  >
                    {busy === "request" ? "Checking…" : "Continue"}
                  </Button>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    A 6-digit confirmation code was emailed to {sentTo ?? "your email address"} — it is
                    deliberately not shown in the app. Enter it within 10 minutes
                    to release {amount} {asset} to {destination ? short(destination) : "the destination"}.
                  </p>

                  <input
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm tracking-widest"
                    placeholder="000000"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <div className="flex gap-2">
                    <Button disabled={busy !== null || code.length !== 6} onClick={finishWithdrawal}>
                      {busy === "confirm" ? "Sending…" : "Confirm & send"}
                    </Button>
                    <Button variant="outline" onClick={abandon}>Cancel</Button>
                  </div>
                </div>
              )}
            </section>
          )}

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">Withdrawal requests</h2>
            {data.withdrawals.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No withdrawals yet.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {data.withdrawals.map(w => (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2">
                    <span>{Number(w.amount)} {w.asset} → {short(w.destination)}</span>
                    <span className="text-xs text-muted-foreground">
                      {w.status}{w.error ? ` — ${w.error}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold">On-chain activity</h2>
            {data.chain.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Nothing on-chain yet — this address has no transactions.
              </p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {data.chain.map(tx => (
                  <li key={tx.signature} className="flex items-center justify-between gap-2">
                    <a
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      href={`https://solscan.io/tx/${tx.signature}`}
                      target="_blank" rel="noreferrer"
                    >
                      {short(tx.signature)} <ExternalLink className="h-3 w-3" />
                    </a>
                    <span className="text-xs text-muted-foreground">
                      {tx.time ? new Date(tx.time).toLocaleString() : "pending"}{tx.err ? " — failed" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}
