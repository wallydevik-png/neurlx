import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  TerminalSquare, LayoutDashboard, Plug, Signal, CheckSquare, Activity, LineChart,
  History, Sliders, BarChart3, Power, LogOut, FlaskConical, Target, Brain,
  Layers, SlidersHorizontal, EyeOff,
} from "lucide-react";
import { setKillSwitch, getDashboard } from "@/lib/trading.functions";
import { toast } from "sonner";
import type { ReactNode } from "react";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/portfolio", label: "AI Decision Center", icon: Brain },
  { to: "/market", label: "Market Scanner", icon: LineChart },
  { to: "/accounts", label: "Connected Accounts", icon: Plug },
  { to: "/signals", label: "AI Signals", icon: Signal },
  { to: "/approvals", label: "Approvals", icon: CheckSquare },
  { to: "/positions", label: "Positions", icon: Activity },
  { to: "/strategies", label: "Strategies", icon: Layers },
  { to: "/lab", label: "Strategy Lab", icon: FlaskConical },
  { to: "/optimizer", label: "Optimizer", icon: SlidersHorizontal },
  { to: "/shadow", label: "Shadow Mode", icon: EyeOff },
  { to: "/accuracy", label: "AI Accuracy", icon: Target },
  { to: "/history", label: "History", icon: History },
  { to: "/automation", label: "Automation", icon: Sliders },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: s => s.location.pathname });
  const fetchDash = useServerFn(getDashboard);
  const kill = useServerFn(setKillSwitch);
  const { data } = useQuery({ queryKey: ["dashboard-mini"], queryFn: () => fetchDash(), refetchInterval: 15000 });

  const killActive = data?.settings?.kill_switch_active;

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  async function toggleKill() {
    try {
      await kill({ data: { active: !killActive } });
      toast.success(killActive ? "Kill switch deactivated" : "Kill switch ACTIVE — all automation halted");
      qc.invalidateQueries();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 border-r border-border bg-card/40 flex flex-col">
        <div className="p-4 border-b border-border flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-primary/20 border border-primary/40 grid place-items-center">
            <TerminalSquare className="w-4 h-4 text-primary" />
          </div>
          <div>
            <div className="font-semibold text-sm">Helix</div>
            <div className="text-[10px] font-mono text-muted-foreground">paper · v0.1</div>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-0.5">
          {NAV.map(item => {
            const active = pathname === item.to || pathname.startsWith(item.to + "/");
            return (
              <Link key={item.to} to={item.to}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition ${
                  active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}>
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t border-border space-y-1">
          <button onClick={toggleKill}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium border ${
              killActive
                ? "bg-destructive text-destructive-foreground border-destructive"
                : "border-destructive/40 text-destructive hover:bg-destructive/10"
            }`}>
            <Power className="w-4 h-4" />
            {killActive ? "Kill switch ON" : "Emergency stop"}
          </button>
          <button onClick={signOut} className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50">
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        {killActive && (
          <div className="bg-destructive/15 border-b border-destructive/40 text-destructive text-xs px-6 py-2 font-medium">
            KILL SWITCH ACTIVE — all automated trading and signal generation is halted.
          </div>
        )}
        <div className="p-8 max-w-7xl">{children}</div>
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="panel p-5">
      <div className="text-xs font-mono text-muted-foreground">{label.toUpperCase()}</div>
      <div className={`mt-1 text-2xl font-mono tabular ${tone === "pos" ? "text-success" : tone === "neg" ? "text-destructive" : ""}`}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

export function fmtUsd(n: number | string | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function fmtNum(n: number | string | null | undefined, dp = 4) {
  return Number(n ?? 0).toLocaleString(undefined, { maximumFractionDigits: dp });
}

export function fmtPct(n: number) {
  return (n * 100).toFixed(1) + "%";
}
