import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import { acknowledgeDisclaimer, getProfile, getSettings, updateSettings } from "@/lib/trading.functions";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/automation")({
  head: () => ({ meta: [{ title: "Automation — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Automation,
});

const MODES = [
  { id: "manual", label: "Manual", desc: "AI provides signals only. You place every trade." },
  { id: "assisted", label: "Assisted", desc: "AI proposes trades; you approve each one." },
  { id: "autonomous", label: "Autonomous", desc: "AI executes automatically inside your risk envelope." },
] as const;

function Automation() {
  const getFn = useServerFn(getSettings);
  const updateFn = useServerFn(updateSettings);
  const profileFn = useServerFn(getProfile);
  const ackFn = useServerFn(acknowledgeDisclaimer);
  const qc = useQueryClient();

  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: () => getFn() });
  const { data: profile } = useQuery({ queryKey: ["profile"], queryFn: () => profileFn() });

  const [form, setForm] = useState({
    mode: "manual",
    riskLevel: "balanced",
    maxTradeSize: 1000,
    maxDailyLoss: 500,
    maxTradesPerDay: 10,
    minConfidence: 0.7,
    allowedAssets: "BTC-USD,ETH-USD,SOL-USD",
  });
  const [showDisclaimer, setShowDisclaimer] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setForm({
      mode: settings.mode,
      riskLevel: settings.risk_level,
      maxTradeSize: Number(settings.max_trade_size),
      maxDailyLoss: Number(settings.max_daily_loss),
      maxTradesPerDay: settings.max_trades_per_day,
      minConfidence: Number(settings.min_confidence),
      allowedAssets: (settings.allowed_assets ?? []).join(","),
    });
  }, [settings]);

  async function trySetMode(next: string) {
    if (next === "autonomous" && !profile?.autonomous_disclaimer_acked_at) {
      setShowDisclaimer(true);
      return;
    }
    setForm({ ...form, mode: next });
  }

  async function acknowledge() {
    try {
      await ackFn();
      qc.invalidateQueries({ queryKey: ["profile"] });
      setShowDisclaimer(false);
      setForm({ ...form, mode: "autonomous" });
      toast.success("Disclaimer acknowledged. Autonomous mode is now available.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function save() {
    try {
      await updateFn({
        data: {
          mode: form.mode as "manual" | "assisted" | "autonomous",
          riskLevel: form.riskLevel as "conservative" | "balanced" | "aggressive",
          maxTradeSize: form.maxTradeSize,
          maxDailyLoss: form.maxDailyLoss,
          maxTradesPerDay: form.maxTradesPerDay,
          minConfidence: form.minConfidence,
          allowedAssets: form.allowedAssets.split(",").map(s => s.trim()).filter(Boolean),
        },
      });
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader title="Automation Settings" subtitle="Configure how the AI trades on your behalf. Changes are audited." />

      <section className="panel p-6">
        <h2 className="font-semibold mb-4">Operation mode</h2>
        <div className="grid md:grid-cols-3 gap-3">
          {MODES.map(m => (
            <button key={m.id} type="button" onClick={() => trySetMode(m.id)}
              className={`text-left p-4 rounded-lg border transition ${
                form.mode === m.id
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-border/80"
              }`}>
              <div className="flex justify-between">
                <div className="font-mono uppercase text-xs">{m.label}</div>
                {form.mode === m.id && <div className="text-[10px] font-mono text-primary">ACTIVE</div>}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{m.desc}</p>
            </button>
          ))}
        </div>
      </section>

      <section className="panel p-6 mt-4">
        <h2 className="font-semibold mb-4">Risk envelope</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <NumField label="Max trade size (USD)" value={form.maxTradeSize} onChange={v => setForm({ ...form, maxTradeSize: v })} />
          <NumField label="Max daily loss (USD)" value={form.maxDailyLoss} onChange={v => setForm({ ...form, maxDailyLoss: v })} />
          <NumField label="Max trades per day" value={form.maxTradesPerDay} onChange={v => setForm({ ...form, maxTradesPerDay: v })} step={1} />
          <NumField label="Min AI confidence (0–1)" value={form.minConfidence} step={0.05} onChange={v => setForm({ ...form, minConfidence: v })} />
          <div className="md:col-span-2">
            <label className="text-xs font-mono uppercase text-muted-foreground">Allowed assets (comma-separated)</label>
            <input value={form.allowedAssets} onChange={e => setForm({ ...form, allowedAssets: e.target.value })}
              className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary font-mono" />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs font-mono uppercase text-muted-foreground">Risk level</label>
            <div className="mt-1 flex gap-2">
              {(["conservative", "balanced", "aggressive"] as const).map(r => (
                <button key={r} type="button" onClick={() => setForm({ ...form, riskLevel: r })}
                  className={`px-3 py-1.5 rounded-md text-sm font-mono uppercase border ${
                    form.riskLevel === r ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"
                  }`}>{r}</button>
              ))}
            </div>
          </div>
        </div>
        <button onClick={save} className="mt-6 rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground">
          Save settings
        </button>
      </section>

      {showDisclaimer && (
        <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur grid place-items-center px-4">
          <div className="panel p-8 max-w-lg">
            <AlertTriangle className="w-8 h-8 text-warning" />
            <h2 className="mt-3 text-lg font-semibold">Autonomous mode disclaimer</h2>
            <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
              In Autonomous mode the AI will execute trades on your behalf without confirmation, subject only to your
              configured risk envelope. This build trades on a paper account with simulated funds — no real money is at
              risk — but you must still acknowledge that AI-driven trading can incur losses and that past performance
              does not guarantee future results.
            </p>
            <div className="mt-6 flex gap-2 justify-end">
              <button onClick={() => setShowDisclaimer(false)} className="rounded-md border border-border px-4 py-2 text-sm">Cancel</button>
              <button onClick={acknowledge} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">I acknowledge — enable</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function NumField({ label, value, onChange, step = 1 }: { label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div>
      <label className="text-xs font-mono uppercase text-muted-foreground">{label}</label>
      <input type="number" value={value} step={step} onChange={e => onChange(Number(e.target.value))}
        className="mt-1 w-full rounded-md bg-input border border-border px-3 py-2 text-sm outline-none focus:border-primary font-mono" />
    </div>
  );
}
