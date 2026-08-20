import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  runAutonomousCycle, updateAutonomousSettings, getAutonomousStatus,
} from "@/lib/autonomous.functions";
import { Bot, Play, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/autonomous")({
  head: () => ({
    meta: [
      { title: "Autonomous Trading Engine — NeurlX" },
      { name: "description", content: "Control NeurlX autonomous trading, execution confidence, live connections, and cycle status." },
      { property: "og:title", content: "Autonomous Trading Engine — NeurlX" },
      { property: "og:description", content: "Control autonomous trading, confidence thresholds, live connections, and cycle status." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AutonomousPage,
});

function AutonomousPage() {
  const qc = useQueryClient();
  const fetchStatus = useServerFn(getAutonomousStatus);
  const runFn = useServerFn(runAutonomousCycle);
  const saveFn = useServerFn(updateAutonomousSettings);

  const { data, isLoading } = useQuery({
    queryKey: ["autonomous-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 10000,
  });

  const [form, setForm] = useState({
    mode: "manual" as "manual" | "assisted" | "autonomous",
    autonomous_min_confidence: 0.85,
    exec_min_confidence: 0.9,
    autonomous_max_open_positions: 3,
    autonomous_cooldown_seconds: 300,
    autonomous_max_consecutive_losses: 3,
    autonomous_live_enabled: false,
    autonomous_default_connection_id: null as string | null,
    trade_volume_mode: "auto" as "auto" | "fixed",
    fixed_trade_volume: 0.01,
  });

  useEffect(() => {
    if (data?.settings) {
      setForm({
        mode: data.settings.mode as "manual" | "assisted" | "autonomous",
        autonomous_min_confidence: Number(data.settings.autonomous_min_confidence ?? 0.85),
        exec_min_confidence: Number(data.settings.exec_min_confidence ?? 0.9),
        autonomous_max_open_positions: data.settings.autonomous_max_open_positions ?? 3,
        autonomous_cooldown_seconds: data.settings.autonomous_cooldown_seconds ?? 300,
        autonomous_max_consecutive_losses: data.settings.autonomous_max_consecutive_losses ?? 3,
        autonomous_live_enabled: data.settings.autonomous_live_enabled ?? false,
        autonomous_default_connection_id: data.settings.autonomous_default_connection_id ?? null,
        trade_volume_mode: (data.settings.trade_volume_mode as "auto" | "fixed" | null) ?? "auto",
        fixed_trade_volume: Number(data.settings.fixed_trade_volume ?? 0.01),
      });
    }
  }, [data?.settings]);

  const save = useMutation({
    mutationFn: () => saveFn({ data: form }),
    onSuccess: () => {
      toast.success("Autonomous settings saved.");
      qc.invalidateQueries({ queryKey: ["autonomous-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runNow = useMutation({
    mutationFn: () => runFn(),
    onSuccess: (r) => {
      if (r.skipped) toast.warning(`Cycle skipped: ${humanizeSkip(r.skipped)}`);
      else toast.success(`Cycle done. Executed ${r.executed}, rejected ${r.rejected}.`);
      qc.invalidateQueries({ queryKey: ["autonomous-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const liveConns = (data?.connections ?? []).filter(
    c => c.trading_enabled && c.status === "connected" && c.connector_id !== "paper"
  );

  return (
    <AppShell>
      <div className="p-6 max-w-6xl space-y-6">
        <div className="flex items-center gap-3">
          <Bot className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Autonomous Trading Engine</h1>
            <p className="text-sm text-muted-foreground">
              When active, the engine auto-executes qualifying signals without approval.
              Every trade still passes the authoritative risk gate and circuit breakers.
            </p>
          </div>
        </div>

        {form.mode === "autonomous" && form.autonomous_live_enabled && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 flex gap-3">
            <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
            <div className="text-sm">
              <strong>Live autonomous mode is ACTIVE.</strong> Real orders will be placed on your
              exchange without confirmation. Use the emergency kill switch in the header to stop
              immediately.
            </div>
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Trading Mode</Label>
                <div className="flex gap-2 mt-2">
                  {(["manual", "assisted", "autonomous"] as const).map(m => (
                    <Button key={m}
                      variant={form.mode === m ? "default" : "outline"}
                      size="sm"
                      onClick={() => setForm(f => ({ ...f, mode: m }))}>
                      {m}
                    </Button>
                  ))}
                </div>
              </div>

              <div>
                <Label>Min confidence ({(form.autonomous_min_confidence * 100).toFixed(0)}%)</Label>
                <Input type="range" min={0.4} max={0.99} step={0.01}
                  value={form.autonomous_min_confidence}
                  onChange={e => setForm(f => ({ ...f, autonomous_min_confidence: Number(e.target.value) }))} />
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <Label>Execution confidence floor ({(form.exec_min_confidence * 100).toFixed(0)}%)</Label>
                  <Button asChild variant="link" size="sm" className="h-auto p-0">
                    <Link to="/shadow">View shadow trades</Link>
                  </Button>
                </div>
                <Input type="range" min={0.4} max={0.99} step={0.01}
                  value={form.exec_min_confidence}
                  onChange={e => setForm(f => ({ ...f, exec_min_confidence: Number(e.target.value) }))} />
                <p className="text-xs text-muted-foreground">
                  Signals below this final execution threshold are tracked in Shadow Mode instead of sent live.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Max open positions</Label>
                  <Input type="number" min={1} max={20}
                    value={form.autonomous_max_open_positions}
                    onChange={e => setForm(f => ({ ...f, autonomous_max_open_positions: Number(e.target.value) }))} />
                </div>
                <div>
                  <Label>Cooldown (sec)</Label>
                  <Input type="number" min={30} max={3600}
                    value={form.autonomous_cooldown_seconds}
                    onChange={e => setForm(f => ({ ...f, autonomous_cooldown_seconds: Number(e.target.value) }))} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Trade volume</Label>
                <div className="flex gap-2">
                  {(["auto", "fixed"] as const).map(v => (
                    <Button key={v}
                      variant={form.trade_volume_mode === v ? "default" : "outline"}
                      size="sm"
                      onClick={() => setForm(f => ({ ...f, trade_volume_mode: v }))}>
                      {v === "auto" ? "Auto (risk-based)" : "Fixed volume"}
                    </Button>
                  ))}
                </div>
                {form.trade_volume_mode === "fixed" && (
                  <Input type="number" min={0.001} max={1000} step={0.01}
                    value={form.fixed_trade_volume}
                    onChange={e => setForm(f => ({ ...f, fixed_trade_volume: Number(e.target.value) }))} />
                )}
                <p className="text-xs text-muted-foreground">
                  Fixed mode sends exactly this lot/volume on every trade. Risk limits,
                  margin checks and notional caps still apply.
                </p>
              </div>


              <div>
                <Label>Max consecutive losses (breaker trips at)</Label>
                <Input type="number" min={1} max={10}
                  value={form.autonomous_max_consecutive_losses}
                  onChange={e => setForm(f => ({ ...f, autonomous_max_consecutive_losses: Number(e.target.value) }))} />
              </div>

              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Autonomous LIVE trading</Label>
                    <p className="text-xs text-muted-foreground">
                      Off = paper only. On = real orders on selected connection.
                    </p>
                  </div>
                  <Switch checked={form.autonomous_live_enabled}
                    onCheckedChange={v => setForm(f => ({ ...f, autonomous_live_enabled: v }))} />
                </div>

                {form.autonomous_live_enabled && (
                  <div>
                    <Label>Live connection</Label>
                    <select
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={form.autonomous_default_connection_id ?? ""}
                      onChange={e => setForm(f => ({
                        ...f, autonomous_default_connection_id: e.target.value || null,
                      }))}>
                      <option value="">— Select —</option>
                      {liveConns.map(c => (
                        <option key={c.id} value={c.id}>{c.label} ({c.connector_id})</option>
                      ))}
                    </select>
                    {liveConns.length === 0 && (
                      <p className="text-xs text-destructive mt-1">
                        No live-enabled connections. Activate one first in Connected Accounts.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <Button onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save settings"}
                </Button>
                <Button variant="outline" onClick={() => runNow.mutate()}
                  disabled={runNow.isPending || form.mode !== "autonomous"}>
                  <Play className="h-4 w-4 mr-2" />
                  {runNow.isPending ? "Running…" : "Run cycle now"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Live status</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Mode" value={data?.settings?.mode ?? "—"} />
              <Row label="Open positions" value={`${data?.openPositions ?? 0} / ${form.autonomous_max_open_positions}`} />
              <Row label="Kill switch"
                value={data?.settings?.kill_switch_active
                  ? <span className="text-destructive">ACTIVE</span>
                  : <span className="text-emerald-500">clear</span>} />
              <Row label="Circuit breaker"
                value={data?.settings?.live_kill_until && new Date(data.settings.live_kill_until) > new Date()
                  ? <span className="text-destructive">OPEN — {data.settings.live_kill_reason}</span>
                  : <span className="text-emerald-500">closed</span>} />
              <Row label="Enforced cooldown"
                value={`${data?.settings?.autonomous_cooldown_seconds ?? "—"}s (from database)`} />
              <Row label="Last run" value={data?.settings?.autonomous_last_run_at
                ? new Date(data.settings.autonomous_last_run_at).toLocaleString() : "never"} />
              <Row label="Live enabled"
                value={data?.settings?.autonomous_live_enabled
                  ? <span className="text-destructive font-semibold">YES (real money)</span>
                  : <span className="text-muted-foreground">no (paper)</span>} />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader><CardTitle>Rejection funnel — last 7 days</CardTitle></CardHeader>
          <CardContent>
            {(data?.rejectionBreakdown?.stages ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No rejections recorded yet.</p>
            )}
            {(data?.rejectionBreakdown?.stages ?? []).length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Biggest bottleneck:{" "}
                  <span className="font-semibold text-foreground">{data?.rejectionBreakdown?.bottleneck}</span>{" "}
                  ({data?.rejectionBreakdown?.total} candidate rejections total)
                </p>
                {(data?.rejectionBreakdown?.stages ?? []).map(s => (
                  <div key={s.stage} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-mono">{s.stage}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {s.count} · {(s.share * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded bg-muted">
                      <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.max(2, s.share * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>htf_conflict breakdown — last 7 days</CardTitle></CardHeader>
          <CardContent>
            {(data?.htfSeverity?.total ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">
                No higher-timeframe conflicts recorded yet by the counters. Buckets are now taken
                from the same rolling telemetry as the funnel, so they start accumulating from the
                next cycle.
              </p>
            )}
            {(data?.htfSeverity?.total ?? 0) > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  {data?.htfSeverity?.total} of {data?.htfSeverity?.conflictTotal} htf_conflict
                  rejections classified
                  {(data?.htfSeverity?.unmeasured ?? 0) > 0 && (
                    <> · {data?.htfSeverity?.unmeasured} counted before per-severity telemetry existed</>
                  )}
                </p>
                {(data?.htfSeverity?.buckets ?? []).map(b => (
                  <div key={b.agree} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-mono">{b.agree}/3 agree ({b.label})</span>
                      <span className="tabular-nums text-muted-foreground">
                        {b.count} · {(b.share * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded bg-muted">
                      <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.max(2, b.share * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Recent cycles</CardTitle></CardHeader>
          <CardContent>
            {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {!isLoading && (data?.runs ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No cycles yet. Set mode to autonomous and click "Run cycle now".</p>
            )}
            <div className="space-y-2">
              {(data?.runs ?? []).map(r => (
                <div key={r.id} className="rounded border p-3 text-sm flex items-start gap-3">
                  {r.signals_executed > 0
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5" />
                    : <XCircle className="h-4 w-4 text-muted-foreground mt-0.5" />}
                  <div className="flex-1">
                    <div className="flex justify-between">
                      <span>{new Date(r.started_at).toLocaleString()}</span>
                      <span className="text-xs text-muted-foreground">
                        trigger: {r.trigger}{r.live ? " · LIVE" : " · paper"}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      scanned {r.signals_scanned} · executed {r.signals_executed} · rejected {r.signals_rejected}
                    </div>
                    {Object.keys(r.reject_reasons ?? {}).length > 0 && (
                      <div className="text-xs text-muted-foreground mt-1">
                        reasons: {Object.entries(r.reject_reasons as Record<string, number>)
                          .map(([k, v]) => `${k}×${v}`).join(", ")}
                      </div>
                    )}
                    {Array.isArray(r.errors) && (r.errors as unknown[]).length > 0 && (
                      <div className="text-xs text-destructive mt-1">
                        errors: {(r.errors as string[]).join("; ")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

/** Cycle skip reasons carry raw UTC ISO timestamps (e.g.
 *  `cooldown_until:2026-08-04T22:07:10.137Z`). Render them in the viewer's own
 *  timezone so a UTC stamp never looks like a multi-hour cooldown. */
function humanizeSkip(reason: string): string {
  return reason.replace(
    /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g,
    iso => new Date(iso).toLocaleTimeString(),
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
