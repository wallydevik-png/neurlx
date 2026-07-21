import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { AppShell, PageHeader } from "@/components/AppShell";
import { getDashboard } from "@/lib/trading.functions";
import { getReadinessScore } from "@/lib/monitoring.functions";
import { CheckCircle2, Circle, ArrowRight, Lock } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [{ title: "Get Started — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: Onboarding,
});

type Step = {
  id: string;
  title: string;
  description: string;
  cta: { label: string; to: string };
  done: boolean;
  locked?: boolean;
  lockReason?: string;
};

function Onboarding() {
  const fetchDash = useServerFn(getDashboard);
  const fetchReadiness = useServerFn(getReadinessScore);
  const { data: dash } = useQuery({ queryKey: ["onb-dash"], queryFn: () => fetchDash() });
  const { data: ready } = useQuery({ queryKey: ["onb-ready"], queryFn: () => fetchReadiness() });
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try { setDismissed(JSON.parse(localStorage.getItem("neurlx.onboarding.dismissed") || "{}")); } catch {}
  }, []);
  function dismiss(id: string) {
    const next = { ...dismissed, [id]: true };
    setDismissed(next);
    localStorage.setItem("neurlx.onboarding.dismissed", JSON.stringify(next));
  }

  const hasPaper = !!dash?.account;
  const paperTrades = dash?.metrics?.totalClosed ?? 0;
  const hasConnection = (dash?.connections?.length ?? 0) > 0;
  const hasReadOnlyLive = (dash?.connections ?? []).some(c => c.status === "connected");
  const tier = ready?.tier ?? "not_ready";
  const readyForAssisted = tier === "ready_for_assisted";
  const anyLiveEnabled = (dash?.connections ?? []).some(c => c.trading_enabled);

  const steps: Step[] = [
    {
      id: "paper",
      title: "1. Start Paper Trading",
      description: "A simulated $10,000 account is created automatically. Practice with zero risk.",
      cta: { label: hasPaper ? "View Paper Account" : "Open Dashboard", to: "/dashboard" },
      done: hasPaper,
    },
    {
      id: "signals",
      title: "2. Generate AI Signals",
      description: "Scan the market and let the AI produce signals with confidence + rationale.",
      cta: { label: "Open Scanner", to: "/market" },
      done: (dash?.metrics?.openCount ?? 0) > 0 || paperTrades > 0 || !!dismissed["signals"],
    },
    {
      id: "approve",
      title: "3. Approve Your First Paper Trade",
      description: "Review a signal, adjust size, and route it to your paper account.",
      cta: { label: "Go to Approvals", to: "/approvals" },
      done: paperTrades >= 1,
    },
    {
      id: "backtest",
      title: "4. Backtest a Strategy",
      description: "Validate ideas against historical data with fees + slippage modeled in.",
      cta: { label: "Strategy Lab", to: "/lab" },
      done: !!dismissed["backtest"],
    },
    {
      id: "connect",
      title: "5. Connect an Exchange (Read-Only)",
      description: "Add a read-only Binance API key. No withdrawal permissions accepted.",
      cta: { label: hasConnection ? "Manage Accounts" : "Connect Exchange", to: "/accounts" },
      done: hasReadOnlyLive,
    },
    {
      id: "shadow",
      title: "6. Run Shadow Mode",
      description: "AI trades against live market data — with zero capital at risk. Builds confidence.",
      cta: { label: "Open Shadow Mode", to: "/shadow" },
      done: (ready?.buckets?.find(b => b.label.toLowerCase().includes("shadow"))?.score ?? 0) > 0,
    },
    {
      id: "readiness",
      title: "7. Reach Readiness Tier",
      description: "Composite AI Readiness Score must reach 'Ready for Assisted' before live trading unlocks.",
      cta: { label: "View Readiness", to: "/readiness" },
      done: readyForAssisted,
    },
    {
      id: "assisted",
      title: "8. Enable Assisted Live Trading",
      description: "Approve each trade manually. Small position caps + safety breakers stay active.",
      cta: { label: "Activate Live", to: "/accounts" },
      done: anyLiveEnabled,
      locked: !readyForAssisted,
      lockReason: "Unlocks after AI Readiness reaches 'Ready for Assisted'.",
    },
    {
      id: "autonomous",
      title: "9. Graduate to Autonomous (Optional)",
      description: "Only after sustained assisted performance. Consecutive-loss breakers auto-halt the bot.",
      cta: { label: "Autonomous Engine", to: "/autonomous" },
      done: false,
      locked: !anyLiveEnabled,
      lockReason: "Unlocks after Assisted Live is enabled and has a proven track record.",
    },
  ];

  const completed = steps.filter(s => s.done).length;
  const pct = Math.round((completed / steps.length) * 100);

  return (
    <AppShell>
      <PageHeader
        title="Get Started"
        subtitle="A guided path from paper trading to fully autonomous. Safety gates unlock as you build a track record."
      />

      <div className="panel p-6 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm text-muted-foreground">Overall Progress</div>
          <div className="text-sm font-mono">{completed} / {steps.length} · {pct}%</div>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid gap-3">
        {steps.map((s) => {
          const Icon = s.done ? CheckCircle2 : s.locked ? Lock : Circle;
          return (
            <div
              key={s.id}
              className={`panel p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3 ${
                s.done ? "opacity-70" : ""
              }`}
            >
              <div className="flex items-start gap-3">
                <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${
                  s.done ? "text-success" : s.locked ? "text-muted-foreground" : "text-primary"
                }`} />
                <div>
                  <div className="font-medium">{s.title}</div>
                  <div className="text-sm text-muted-foreground mt-1">{s.description}</div>
                  {s.locked && s.lockReason && (
                    <div className="text-xs text-warning mt-1">{s.lockReason}</div>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                {!s.done && !s.locked && (
                  <button
                    onClick={() => dismiss(s.id)}
                    className="text-xs text-muted-foreground hover:text-foreground px-2"
                  >
                    Skip
                  </button>
                )}
                <Link
                  to={s.cta.to}
                  className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-sm ${
                    s.locked
                      ? "bg-muted text-muted-foreground pointer-events-none"
                      : s.done
                      ? "bg-muted hover:bg-muted/80"
                      : "bg-primary text-primary-foreground hover:bg-primary/90"
                  }`}
                >
                  {s.cta.label}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>

      <div className="panel p-5 mt-6 border-l-2 border-primary">
        <div className="text-sm font-medium mb-1">Safety First</div>
        <div className="text-sm text-muted-foreground">
          Every stage has independent safety gates. The kill switch (top right) halts all automation instantly.
          Live trading remains disabled by the platform until your readiness score qualifies — this is not optional.
        </div>
      </div>
    </AppShell>
  );
}
