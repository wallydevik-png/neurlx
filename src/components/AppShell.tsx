import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import {
  TerminalSquare, LayoutDashboard, Plug, Signal, CheckSquare, Activity, LineChart,
  History, Sliders, BarChart3, Power, LogOut, FlaskConical, Target, Brain,
  Layers, Layers3, SlidersHorizontal, EyeOff, Menu, X, Gauge, Radar, BookOpen, TrendingUp,
  Sparkles, Wallet, Bot, Bell, Rocket, ScrollText, Smartphone, Fingerprint, WifiOff,
  Sun, Moon, Shield, HeartPulse, Banknote, Globe, Trophy,
} from "lucide-react";
import { unreadNotificationCount } from "@/lib/notifications.functions";
import { Logo } from "@/components/Logo";
import { setKillSwitch, getDashboard } from "@/lib/trading.functions";
import { listCredentials } from "@/lib/webauthn.functions";
import { usePWA, vibrate } from "@/hooks/usePWA";
import { useBiometric } from "@/hooks/useBiometric";
import { useTheme } from "@/hooks/useTheme";
import { toast } from "sonner";

const NAV = [
  { to: "/onboarding", label: "Get Started", icon: Rocket },
  { to: "/assistant", label: "Personal Assistant", icon: Sparkles },
  { to: "/community", label: "Community", icon: Trophy },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/monitoring", label: "Live Monitoring", icon: Radar },
  { to: "/intelligence", label: "Live Intelligence", icon: Sparkles },
  { to: "/capital", label: "Capital Growth", icon: Wallet },
  { to: "/capital-management", label: "Capital Management", icon: Banknote },
  { to: "/readiness", label: "Readiness Score", icon: Gauge },
  { to: "/portfolio", label: "AI Decision Center", icon: Brain },
  { to: "/risk", label: "Advanced Risk", icon: Shield },
  { to: "/market", label: "Market Scanner", icon: LineChart },
  { to: "/intel", label: "Market Intelligence", icon: Radar },
  { to: "/altdata", label: "Alternative Data", icon: Layers3 },
  { to: "/research", label: "Research Lab", icon: FlaskConical },
  { to: "/multi-asset", label: "Multi-Asset", icon: Globe },
  { to: "/accounts", label: "Connected Accounts", icon: Plug },
  { to: "/signals", label: "AI Signals", icon: Signal },
  { to: "/approvals", label: "Approvals", icon: CheckSquare },
  { to: "/positions", label: "Positions", icon: Activity },
  { to: "/strategies", label: "Strategies", icon: Layers },
  { to: "/lab", label: "Strategy Lab", icon: FlaskConical },
  { to: "/optimizer", label: "Optimizer", icon: SlidersHorizontal },
  { to: "/shadow", label: "Shadow Mode", icon: EyeOff },
  { to: "/accuracy", label: "AI Accuracy", icon: Target },
  { to: "/journal", label: "Trade Journal", icon: BookOpen },
  { to: "/performance", label: "Performance", icon: TrendingUp },
  { to: "/history", label: "History", icon: History },
  { to: "/automation", label: "Automation", icon: Sliders },
  { to: "/autonomous", label: "Autonomous Engine", icon: Bot },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/compliance", label: "Compliance & Data", icon: ScrollText },
  { to: "/mobile", label: "Mobile & Security", icon: Smartphone },
  { to: "/reliability", label: "Reliability", icon: HeartPulse },
  { to: "/validation", label: "AI Validation", icon: Brain },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pathname = useRouterState({ select: s => s.location.pathname });
  const fetchDash = useServerFn(getDashboard);
  const fetchUnread = useServerFn(unreadNotificationCount);
  const kill = useServerFn(setKillSwitch);
  const fetchCreds = useServerFn(listCredentials);
  const { data } = useQuery({ queryKey: ["dashboard-mini"], queryFn: () => fetchDash(), refetchInterval: 15000 });
  const { data: unreadData } = useQuery({ queryKey: ["notifications-unread"], queryFn: () => fetchUnread(), refetchInterval: 20000 });
  const { data: credsData } = useQuery({ queryKey: ["biometric-creds"], queryFn: () => fetchCreds() });
  const unread = unreadData?.unread ?? 0;
  const hasCredentials = (credsData ?? []).length > 0;
  const { isOnline } = usePWA();
  const { authenticate } = useBiometric();
  const { theme, toggle: toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const killActive = data?.settings?.kill_switch_active;
  const current = NAV.find(n => pathname === n.to || pathname.startsWith(n.to + "/"));

  // Close drawer on route change
  useEffect(() => { setOpen(false); }, [pathname]);
  // Lock body scroll when drawer open
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  async function signOut() {
    await qc.cancelQueries();
    qc.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }
  async function toggleKill() {
    try {
      if (killActive && hasCredentials) {
        await authenticate();
      }
      await kill({ data: { active: !killActive } });
      vibrate(killActive ? [30] : [60, 30]);
      toast.success(killActive ? "Kill switch deactivated" : "Kill switch ACTIVE — all automation halted");
      qc.invalidateQueries();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top bar — always visible on every device */}
      <header className="sticky top-0 z-40 border-b border-border bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60">
        <div className="flex items-center gap-3 px-4 sm:px-6 h-14">
          <button
            onClick={() => setOpen(v => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            className="relative w-10 h-10 grid place-items-center rounded-md border border-border hover:bg-secondary/50 transition shrink-0"
          >
            <span className="sr-only">Menu</span>
            <Menu className={`w-5 h-5 absolute transition-all duration-200 ${open ? "opacity-0 rotate-90 scale-75" : "opacity-100 rotate-0 scale-100"}`} />
            <X className={`w-5 h-5 absolute transition-all duration-200 ${open ? "opacity-100 rotate-0 scale-100" : "opacity-0 -rotate-90 scale-75"}`} />
          </button>

          <Link to="/dashboard" className="min-w-0">
            <Logo size="md" />
            <div className="text-[10px] font-mono text-muted-foreground leading-tight pl-10 hidden sm:block -mt-1">
              Neural precision, executed.
            </div>
          </Link>

          {current && (
            <div className="ml-2 pl-3 border-l border-border min-w-0 hidden sm:block">
              <div className="text-xs font-mono uppercase text-muted-foreground leading-tight">Section</div>
              <div className="text-sm font-medium truncate">{current.label}</div>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {!isOnline && (
              <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium bg-warning/15 text-warning border border-warning/30">
                <WifiOff className="w-3.5 h-3.5" /> Offline
              </span>
            )}
            <button
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="w-10 h-10 grid place-items-center rounded-md border border-border hover:bg-secondary/50"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link to="/notifications" aria-label="Notifications"
              className="relative w-10 h-10 grid place-items-center rounded-md border border-border hover:bg-secondary/50">
              <Bell className="w-4 h-4" />
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-mono grid place-items-center">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Link>
            <button
              onClick={toggleKill}
              className={`hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border ${
                killActive
                  ? "bg-destructive text-destructive-foreground border-destructive"
                  : "border-destructive/40 text-destructive hover:bg-destructive/10"
              }`}
            >
              <Power className="w-3.5 h-3.5" />
              {killActive ? "Kill ON" : "Emergency stop"}
            </button>
            <button
              onClick={toggleKill}
              aria-label="Emergency stop"
              className={`sm:hidden w-10 h-10 grid place-items-center rounded-md border ${
                killActive
                  ? "bg-destructive text-destructive-foreground border-destructive"
                  : "border-destructive/40 text-destructive"
              }`}
            >
              <Power className="w-4 h-4" />
            </button>
          </div>
        </div>

        {killActive && (
          <div className="bg-destructive/15 border-t border-destructive/40 text-destructive text-[11px] sm:text-xs px-4 sm:px-6 py-1.5 font-medium">
            KILL SWITCH ACTIVE — all automated trading and signal generation is halted.
          </div>
        )}
      </header>

      {/* Drawer overlay */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-40 bg-background/70 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        style={{ top: 56 }}
        aria-hidden={!open}
      />

      {/* Drawer panel — slides in from the left on all sizes */}
      <aside
        className={`fixed z-50 left-0 bottom-0 w-72 max-w-[85vw] bg-card border-r border-border flex flex-col transition-transform duration-250 ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{ top: 56 }}
        aria-hidden={!open}
      >
        <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {NAV.map(item => {
            const active = pathname === item.to || pathname.startsWith(item.to + "/");
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm transition ${
                  active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                <item.icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t border-border">
          <button
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 pb-16 sm:pb-0">
        <div className="p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">{children}</div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-card/90 backdrop-blur border-t border-border pb-[env(safe-area-inset-bottom)]">
        {!isOnline && (
          <div className="bg-warning/15 text-warning text-[10px] font-medium text-center py-1 border-b border-warning/20">
            <WifiOff className="w-3 h-3 inline-block align-text-bottom mr-1" /> Offline mode
          </div>
        )}
        <div className="flex items-center justify-around h-14">
          {[
            { to: "/dashboard", icon: LayoutDashboard, label: "Home" },
            { to: "/approvals", icon: CheckSquare, label: "Approvals" },
            { to: "/positions", icon: Activity, label: "Positions" },
            { to: "/mobile", icon: Smartphone, label: "Mobile" },
          ].map(item => {
            const active = pathname === item.to || pathname.startsWith(item.to + "/");
            return (
              <Link
                key={item.to}
                to={item.to}
                className={`flex flex-col items-center justify-center gap-0.5 w-full h-full text-[10px] ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              >
                <item.icon className="w-5 h-5" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 mb-6 sm:flex sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate">{title}</h1>
        {subtitle && <p className="text-xs sm:text-sm text-muted-foreground mt-1">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0 flex flex-wrap gap-2 justify-end">{action}</div>}
    </div>
  );
}

export function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "pos" | "neg" }) {
  return (
    <div className="panel p-4 sm:p-5 min-w-0">
      <div className="text-[10px] sm:text-xs font-mono text-muted-foreground truncate">{label.toUpperCase()}</div>
      <div className={`mt-1 text-lg sm:text-2xl font-mono tabular truncate ${tone === "pos" ? "text-success" : tone === "neg" ? "text-destructive" : ""}`}>{value}</div>
      {sub && <div className="text-[11px] sm:text-xs text-muted-foreground mt-1 truncate">{sub}</div>}
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
