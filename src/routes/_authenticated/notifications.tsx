import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient, useSuspenseQuery, queryOptions } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import {
  listNotifications, markNotificationRead, markAllNotificationsRead,
  updateNotificationPreferences,
} from "@/lib/notifications.functions";
import { toast } from "sonner";
import { Bell, Check, CheckCheck } from "lucide-react";

type NotifData = { notifications: Notif[]; unread: number; preferences: Prefs | null };

const notifsQO = (fetcher: () => Promise<NotifData>) => queryOptions({
  queryKey: ["notifications"],
  queryFn: fetcher,
  refetchInterval: 15000,
});

export const Route = createFileRoute("/_authenticated/notifications")({
  component: NotificationsPage,
  errorComponent: ({ error }) => <div className="p-6 text-destructive">Failed to load: {error.message}</div>,
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

type Notif = {
  id: string; kind: string; severity: string; title: string; message: string;
  read_at: string | null; created_at: string;
};
type Prefs = {
  channels: Record<string, boolean>;
  severity_min: "info"|"warning"|"critical"|"emergency";
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  kind_toggles: Record<string, boolean>;
  email_address: string | null;
  telegram_chat_id: string | null;
  discord_webhook_url: string | null;
};

const DEFAULT_PREFS: Prefs = {
  channels: { inapp: true, email: true, sms: false, telegram: false, discord: false, push: false },
  severity_min: "info", quiet_hours_start: null, quiet_hours_end: null, kind_toggles: {},
  email_address: null, telegram_chat_id: null, discord_webhook_url: null,
};

const SEV_COLORS: Record<string, string> = {
  info: "text-muted-foreground border-border",
  warning: "text-warning border-warning/40 bg-warning/5",
  critical: "text-destructive border-destructive/40 bg-destructive/5",
  emergency: "text-destructive-foreground border-destructive bg-destructive",
};

function NotificationsPage() {
  const qc = useQueryClient();
  const fetch = useServerFn(listNotifications);
  const markOne = useServerFn(markNotificationRead);
  const markAll = useServerFn(markAllNotificationsRead);
  const updatePrefs = useServerFn(updateNotificationPreferences);
  const { data } = useSuspenseQuery(notifsQO(async () => (await fetch()) as unknown as NotifData));

  const notifs = (data?.notifications ?? []) as Notif[];
  const initialPrefs: Prefs = (data?.preferences as Prefs | null) ?? DEFAULT_PREFS;
  const [prefs, setPrefs] = useState<Prefs>(initialPrefs);
  const [filter, setFilter] = useState<"all"|"unread">("all");

  const visible = notifs.filter(n => filter === "all" || !n.read_at);

  async function handleMarkAll() {
    await markAll();
    qc.invalidateQueries({ queryKey: ["notifications"] });
  }
  async function handleMark(id: string) {
    await markOne({ data: { id } });
    qc.invalidateQueries({ queryKey: ["notifications"] });
  }
  async function savePrefs() {
    try {
      await updatePrefs({ data: prefs });
      toast.success("Preferences saved");
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <AppShell>
      <PageHeader
        title="Notifications"
        subtitle="Real-time alerts for trades, autonomous mode, breakers, and system health"
        action={
          <button onClick={handleMarkAll} className="btn-secondary text-xs">
            <CheckCheck className="w-3.5 h-3.5 inline mr-1" /> Mark all read
          </button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-2">
          <div className="flex gap-2 mb-2">
            <button onClick={() => setFilter("all")} className={`text-xs px-2 py-1 rounded ${filter==="all"?"bg-primary/20 text-primary":"text-muted-foreground"}`}>All</button>
            <button onClick={() => setFilter("unread")} className={`text-xs px-2 py-1 rounded ${filter==="unread"?"bg-primary/20 text-primary":"text-muted-foreground"}`}>Unread</button>
          </div>
          {visible.length === 0 && (
            <div className="panel p-8 text-center text-muted-foreground text-sm">
              <Bell className="w-8 h-8 mx-auto mb-2 opacity-40" />
              No notifications
            </div>
          )}
          {visible.map(n => (
            <div key={n.id} className={`panel p-3 border-l-2 ${SEV_COLORS[n.severity] ?? ""} ${!n.read_at ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-medium text-sm">{n.title}</div>
                    <span className="text-[10px] font-mono uppercase text-muted-foreground">{n.kind}</span>
                    <span className={`text-[10px] font-mono uppercase px-1.5 py-0.5 rounded ${SEV_COLORS[n.severity] ?? ""}`}>{n.severity}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{n.message}</div>
                  <div className="text-[10px] font-mono text-muted-foreground mt-1">{new Date(n.created_at).toLocaleString()}</div>
                </div>
                {!n.read_at && (
                  <button onClick={() => handleMark(n.id)} className="text-xs text-muted-foreground hover:text-foreground shrink-0" title="Mark read">
                    <Check className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="panel p-4 space-y-4 h-fit">
          <div className="text-sm font-semibold">Preferences</div>

          <div>
            <div className="text-[11px] font-mono uppercase text-muted-foreground mb-1">Channels</div>
            {(["inapp","email","sms","telegram","discord","push"] as const).map(c => (
              <label key={c} className="flex items-center gap-2 text-xs py-1">
                <input type="checkbox" checked={!!prefs.channels[c]}
                  onChange={e => setPrefs({...prefs, channels: {...prefs.channels, [c]: e.target.checked}})} />
                <span className="capitalize">{c}</span>
                {c !== "inapp" && c !== "email" && <span className="text-[10px] text-muted-foreground">(coming soon)</span>}
              </label>
            ))}
          </div>

          <div>
            <div className="text-[11px] font-mono uppercase text-muted-foreground mb-1">Minimum severity</div>
            <select value={prefs.severity_min}
              onChange={e => setPrefs({...prefs, severity_min: e.target.value as Prefs["severity_min"]})}
              className="w-full bg-background border border-border rounded px-2 py-1 text-xs">
              <option value="info">Info</option><option value="warning">Warning</option>
              <option value="critical">Critical</option><option value="emergency">Emergency only</option>
            </select>
          </div>

          <div>
            <div className="text-[11px] font-mono uppercase text-muted-foreground mb-1">Quiet hours (UTC)</div>
            <div className="flex gap-2 items-center">
              <input type="number" min={0} max={23} placeholder="start"
                value={prefs.quiet_hours_start ?? ""}
                onChange={e => setPrefs({...prefs, quiet_hours_start: e.target.value === "" ? null : Number(e.target.value)})}
                className="w-16 bg-background border border-border rounded px-2 py-1 text-xs" />
              <span className="text-xs text-muted-foreground">to</span>
              <input type="number" min={0} max={23} placeholder="end"
                value={prefs.quiet_hours_end ?? ""}
                onChange={e => setPrefs({...prefs, quiet_hours_end: e.target.value === "" ? null : Number(e.target.value)})}
                className="w-16 bg-background border border-border rounded px-2 py-1 text-xs" />
            </div>
            <div className="text-[10px] text-muted-foreground mt-1">Emergency alerts bypass quiet hours.</div>
          </div>

          <div>
            <div className="text-[11px] font-mono uppercase text-muted-foreground mb-1">Email address</div>
            <input type="email" value={prefs.email_address ?? ""}
              onChange={e => setPrefs({...prefs, email_address: e.target.value || null})}
              className="w-full bg-background border border-border rounded px-2 py-1 text-xs" />
          </div>

          <button onClick={savePrefs} className="btn-primary w-full text-xs">Save preferences</button>
        </div>
      </div>
    </AppShell>
  );
}
