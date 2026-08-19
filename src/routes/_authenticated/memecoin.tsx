import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import {
  getMemecoinDesk, updateMemecoinSettings, saveTradingWalletKey,
  scanMemecoinsNow, snipeSignal, exitMemecoinPosition, runMemecoinCycleNow,
} from "@/lib/memecoin.functions";
import { Rocket, Wallet, ShieldAlert, RefreshCw, Play, KeyRound, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/memecoin")({
  head: () => ({
    meta: [
      { title: "Memecoin Sniper — NeurlX" },
      { name: "description", content: "Autonomous Solana memecoin sniping with liquidity, momentum and rug-risk screening." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: MemecoinDesk,
});

function MemecoinDesk() {
  const deskFn = useServerFn(getMemecoinDesk);
  const saveFn = useServerFn(updateMemecoinSettings);
  const importWalletFn = useServerFn(saveTradingWalletKey);
  const scanFn = useServerFn(scanMemecoinsNow);
  const snipeFn = useServerFn(snipeSignal);
  const exitFn = useServerFn(exitMemecoinPosition);
  const cycleFn = useServerFn(runMemecoinCycleNow);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["memecoin-desk"],
    queryFn: () => deskFn(),
    refetchInterval: 30_000,
  });

  const [form, setForm] = useState({
    enabled: false, autotrade: false, buy_amount_sol: 0.05, max_open_positions: 3,
    take_profit_pct: 60, stop_loss_pct: 25, trailing_stop_pct: 20,
    min_liquidity_usd: 25000, min_score: 70, slippage_bps: 300, max_daily_loss_sol: 0.25,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [walletSecret, setWalletSecret] = useState("");
  const [showWalletSecret, setShowWalletSecret] = useState(false);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => { if (data?.settings) setForm(f => ({ ...f, ...data.settings })); }, [data?.settings]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["memecoin-desk"] });
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Something went wrong");

  async function importWallet() {
    if (!walletSecret.trim()) return;
    try {
      setBusy("wallet-import");
      const result = await importWalletFn({ data: { secretKey: walletSecret } });
      setWalletSecret("");
      setShowImport(false);
      toast.success(`Wallet imported: ${result.publicKey.slice(0, 6)}…${result.publicKey.slice(-4)}`);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    try { setBusy("save"); await saveFn({ data: form }); toast.success("Sniper settings saved"); refresh(); }
    catch (e) { fail(e); } finally { setBusy(null); }
  }

  async function scan() {
    try { setBusy("scan"); const r = await scanFn(); toast.success(`Scanned ${r.scanned} tokens`); refresh(); }
    catch (e) { fail(e); } finally { setBusy(null); }
  }

  async function runCycle() {
    try {
      setBusy("cycle");
      const r = await cycleFn();
      toast.success(r.skipped ? `Cycle skipped: ${r.skipped}` : `Entries ${r.entries.length} · exits ${r.exits.length}`);
      refresh();
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  const signals = data?.signals ?? [];
  const canTrade = Boolean(data?.wallet?.hasKey);

  return (
    <AppShell>
      <PageHeader
        title="Memecoin Sniper"
        subtitle="Solana memecoin intelligence and execution. Every candidate is screened for liquidity depth, buy pressure, momentum shape and rug geometry before a lamport is spent."
      />

      {isLoading && <div className="panel p-6 text-sm text-muted-foreground">Loading the desk…</div>}

      <div className="grid gap-4 md:grid-cols-4 mt-4">
        <Metric label="Wallet" value={data?.wallet?.sol != null ? `${data.wallet.sol.toFixed(3)} SOL` : "—"} sub={data?.wallet?.public_key ? `${data.wallet.public_key.slice(0, 4)}…${data.wallet.public_key.slice(-4)}` : "not linked"} />
        <Metric label="Open snipes" value={String(data?.open?.length ?? 0)} sub={`max ${form.max_open_positions}`} />
        <Metric label="Realised P&L" value={`${(data?.stats.realisedSol ?? 0) >= 0 ? "+" : ""}${(data?.stats.realisedSol ?? 0).toFixed(3)} SOL`} tone={(data?.stats.realisedSol ?? 0) >= 0 ? "pos" : "neg"} />
        <Metric label="Win rate" value={`${data?.stats.winRate ?? 0}%`} sub={`${data?.stats.trades ?? 0} closed`} />
      </div>

      <section className="panel p-6 mt-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-semibold flex items-center gap-2"><Wallet className="w-4 h-4" /> Wallet</h2>
            <p className="mt-1 text-sm text-muted-foreground max-w-xl">
              Import a dedicated Phantom wallet to fund and trade directly. Its secret is encrypted immediately,
              never returned to this screen, and only decrypted server-side when signing a swap.
            </p>
          </div>
          <Button onClick={() => setShowImport(v => !v)}>
            <KeyRound /> {data?.wallet?.hasKey ? "Replace wallet" : "Import wallet"}
          </Button>
        </div>
        {showImport && (
          <div className="mt-5 border-t border-border pt-5">
            <label htmlFor="wallet-secret" className="text-sm font-medium">Recovery phrase or private key</label>
            <p className="mt-1 text-xs text-muted-foreground">
              Use a separate low-balance trading wallet—not your primary wallet. Supports Phantom recovery phrases,
              base58 private keys, and 64-byte JSON keys.
            </p>
            <div className="relative mt-3">
              <textarea
                id="wallet-secret"
                value={walletSecret}
                onChange={e => setWalletSecret(e.target.value)}
                rows={3}
                maxLength={500}
                autoComplete="off"
                spellCheck={false}
                placeholder="Enter wallet recovery phrase or private key"
                className="w-full rounded-md bg-input border border-border px-3 py-2 pr-11 text-sm font-mono outline-none focus:border-primary"
                style={{ WebkitTextSecurity: showWalletSecret ? "none" : "disc" }}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => setShowWalletSecret(v => !v)}
                className="absolute right-1 top-1" aria-label={showWalletSecret ? "Hide wallet secret" : "Show wallet secret"}>
                {showWalletSecret ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button onClick={importWallet} disabled={!walletSecret.trim() || busy === "wallet-import"}>
                {busy === "wallet-import" ? "Encrypting…" : "Encrypt & import"}
              </Button>
              <span className="text-xs text-warning inline-flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" /> Never import a wallet holding funds you cannot afford to lose.
              </span>
            </div>
          </div>
        )}
        {!canTrade && (
          <p className="mt-4 text-xs text-warning flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" /> No trading wallet configured yet — the sniper can scan but not execute.
          </p>
        )}
      </section>

      <section className="panel p-6 mt-4">
        <h2 className="font-semibold">Sniper controls</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <Toggle label="Sniper enabled" desc="Scans the Solana memecoin market and manages open snipes."
            value={form.enabled} onChange={v => setForm(f => ({ ...f, enabled: v }))} />
          <Toggle label="Auto-execute (real SOL)" desc="Buys qualifying tokens without asking."
            value={form.autotrade} onChange={v => setForm(f => ({ ...f, autotrade: v }))} />
          <Num label="Buy size (SOL)" step={0.01} value={form.buy_amount_sol} onChange={v => setForm(f => ({ ...f, buy_amount_sol: v }))} />
          <Num label="Max open snipes" value={form.max_open_positions} onChange={v => setForm(f => ({ ...f, max_open_positions: v }))} />
          <Num label="Take profit (%)" value={form.take_profit_pct} onChange={v => setForm(f => ({ ...f, take_profit_pct: v }))} />
          <Num label="Stop loss (%)" value={form.stop_loss_pct} onChange={v => setForm(f => ({ ...f, stop_loss_pct: v }))} />
          <Num label="Trailing stop (%)" value={form.trailing_stop_pct} onChange={v => setForm(f => ({ ...f, trailing_stop_pct: v }))} />
          <Num label="Min liquidity (USD)" step={1000} value={form.min_liquidity_usd} onChange={v => setForm(f => ({ ...f, min_liquidity_usd: v }))} />
          <Num label="Min AI score (0–100)" value={form.min_score} onChange={v => setForm(f => ({ ...f, min_score: v }))} />
          <Num label="Slippage (bps)" step={50} value={form.slippage_bps} onChange={v => setForm(f => ({ ...f, slippage_bps: v }))} />
          <Num label="Daily loss cap (SOL)" step={0.05} value={form.max_daily_loss_sol} onChange={v => setForm(f => ({ ...f, max_daily_loss_sol: v }))} />
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={save} disabled={busy === "save"}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">Save settings</button>
          <button onClick={scan} disabled={busy === "scan"}
            className="rounded-md border border-border px-4 py-2 text-sm inline-flex items-center gap-2 disabled:opacity-60">
            <RefreshCw className="w-4 h-4" /> Scan market
          </button>
          <button onClick={runCycle} disabled={busy === "cycle"}
            className="rounded-md border border-border px-4 py-2 text-sm inline-flex items-center gap-2 disabled:opacity-60">
            <Play className="w-4 h-4" /> Run cycle now
          </button>
        </div>
      </section>

      <section className="panel p-6 mt-4">
        <h2 className="font-semibold flex items-center gap-2"><Rocket className="w-4 h-4" /> Live candidates</h2>
        {!signals.length && <p className="mt-3 text-sm text-muted-foreground">No candidates yet — run a scan.</p>}
        <div className="mt-4 space-y-3">
          {signals.map(s => (
            <div key={s.id} className="rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold">{s.symbol}</span>
                    <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded ${
                      s.verdict === "snipe" ? "bg-primary/15 text-primary"
                        : s.verdict === "watch" ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
                    }`}>{s.verdict}</span>
                    <span className="text-xs text-muted-foreground">score {s.score}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground truncate">{s.ai_thesis ?? s.name}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-muted-foreground">
                    <span>liq ${Math.round(Number(s.liquidity_usd ?? 0)).toLocaleString()}</span>
                    <span>fdv ${Math.round(Number(s.fdv_usd ?? 0)).toLocaleString()}</span>
                    <span>5m {Number(s.change_5m ?? 0).toFixed(1)}%</span>
                    <span>1h {Number(s.change_1h ?? 0).toFixed(1)}%</span>
                    <span>b/s {Number(s.buy_sell_ratio ?? 0).toFixed(2)}</span>
                  </div>
                </div>
                <button
                  disabled={!canTrade || busy === s.id}
                  onClick={async () => {
                    try { setBusy(s.id); await snipeFn({ data: { signalId: s.id } }); toast.success(`Sniped ${s.symbol}`); refresh(); }
                    catch (e) { fail(e); } finally { setBusy(null); }
                  }}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50">
                  Snipe {form.buy_amount_sol} SOL
                </button>
              </div>
              {Array.isArray(s.risk_flags) && s.risk_flags.length > 0 && (
                <p className="mt-2 text-[11px] text-warning">{(s.risk_flags as string[]).join(" · ")}</p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="panel p-6 mt-4">
        <h2 className="font-semibold">Open snipes</h2>
        {!data?.open?.length && <p className="mt-3 text-sm text-muted-foreground">Nothing open right now.</p>}
        <div className="mt-3 space-y-2">
          {(data?.open ?? []).map(p => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="text-sm">
                <div className="font-mono font-semibold">{p.symbol}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {Number(p.amount_sol).toFixed(3)} SOL · entry ${Number(p.entry_price_usd ?? 0).toPrecision(4)}
                </div>
              </div>
              <button onClick={async () => {
                try { setBusy(p.id); await exitFn({ data: { positionId: p.id } }); toast.success("Exit submitted"); refresh(); }
                catch (e) { fail(e); } finally { setBusy(null); }
              }} disabled={busy === p.id}
                className="rounded-md border border-border px-3 py-1.5 text-xs disabled:opacity-60">Sell now</button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel p-6 mt-4 mb-8">
        <h2 className="font-semibold">Closed snipes</h2>
        {!data?.closed?.length && <p className="mt-3 text-sm text-muted-foreground">No closed trades yet.</p>}
        <div className="mt-3 space-y-2">
          {(data?.closed ?? []).map(p => (
            <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <div>
                <div className="font-mono font-semibold">{p.symbol}</div>
                <div className="text-xs text-muted-foreground font-mono">{p.exit_reason}</div>
              </div>
              <div className={`font-mono text-sm ${Number(p.pnl_sol ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>
                {Number(p.pnl_sol ?? 0) >= 0 ? "+" : ""}{Number(p.pnl_sol ?? 0).toFixed(4)} SOL
              </div>
            </div>
          ))}
        </div>
      </section>
    </AppShell>
  );
}

function Num({ label, value, onChange, step = 1 }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="text-xs font-mono uppercase text-muted-foreground">{label}</label>
      <input type="number" step={step} value={value} onChange={e => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary font-mono" />
    </div>
  );
}

function Toggle({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)}
      className={`text-left p-4 rounded-lg border transition ${value ? "border-primary bg-primary/10" : "border-border"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className={`text-[10px] font-mono uppercase ${value ? "text-primary" : "text-muted-foreground"}`}>{value ? "on" : "off"}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </button>
  );
}
