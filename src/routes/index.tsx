import { createFileRoute, Link } from "@tanstack/react-router";
import { Shield, Zap, LineChart, Lock, TerminalSquare, GitBranch, Sun, Moon, Download } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useTheme } from "@/hooks/useTheme";
import { usePWA } from "@/hooks/usePWA";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  const { theme, toggle } = useTheme();
  const { installPrompt, isInstalled, install } = usePWA();
  return (
    <div className="min-h-screen">
      <header className="border-b border-border/60">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <Logo size="md" showTagline />
          <div className="flex items-center gap-2">
            {installPrompt && !isInstalled && (
              <button onClick={install} className="hidden sm:inline-flex items-center gap-1.5 rounded-md border border-primary/40 text-primary px-3 py-2 text-sm font-medium hover:bg-primary/10">
                <Download className="w-4 h-4" /> Install app
              </button>
            )}
            <button
              onClick={toggle}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="w-10 h-10 grid place-items-center rounded-md border border-border hover:bg-secondary/50"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
            <Link to="/auth" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-20">
        <section className="text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" /> Paper trading engine · live
          </div>
          <h1 className="mt-6 text-5xl md:text-6xl font-semibold tracking-tight leading-[1.05]">
            Practice like the pros.<br />
            <span className="text-primary">Trade only when ready.</span>
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            A secure, modular AI trading foundation. Encrypted credentials, multi-layer risk controls,
            an emergency kill switch, and a full audit trail — all on a realistic simulated exchange
            so you can validate strategies before a single real dollar moves.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link to="/auth" className="rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground">
              Open your paper account
            </Link>
            <a href="#features" className="rounded-md border border-border px-6 py-3 text-sm font-medium hover:bg-secondary">
              See the architecture
            </a>
          </div>
        </section>

        <section id="features" className="mt-24 grid md:grid-cols-3 gap-4">
          {FEATURES.map(f => (
            <div key={f.title} className="panel p-6">
              <f.icon className="w-5 h-5 text-primary" />
              <h3 className="mt-3 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.body}</p>
            </div>
          ))}
        </section>

        <section className="mt-24 panel p-8">
          <h2 className="text-2xl font-semibold">Three operation modes</h2>
          <div className="mt-6 grid md:grid-cols-3 gap-4 text-sm">
            <div className="border border-border rounded-lg p-4">
              <div className="font-mono text-xs text-muted-foreground">01 · MANUAL</div>
              <div className="mt-2 font-medium">Signals only</div>
              <p className="mt-2 text-muted-foreground">AI publishes signals to your feed. You place every trade yourself.</p>
            </div>
            <div className="border border-primary/40 rounded-lg p-4 bg-primary/5">
              <div className="font-mono text-xs text-primary">02 · ASSISTED</div>
              <div className="mt-2 font-medium">Approve each trade</div>
              <p className="mt-2 text-muted-foreground">Every AI trade goes to the approval queue with rationale, R:R, and confidence.</p>
            </div>
            <div className="border border-border rounded-lg p-4">
              <div className="font-mono text-xs text-muted-foreground">03 · AUTONOMOUS</div>
              <div className="mt-2 font-medium">Auto-execute within limits</div>
              <p className="mt-2 text-muted-foreground">AI runs inside your risk envelope. Kill switch halts everything instantly.</p>
            </div>
          </div>
        </section>

        <p className="mt-16 text-center text-xs text-muted-foreground max-w-2xl mx-auto">
          Paper trading only. No live exchange connections in this build. Past simulated performance
          does not guarantee future results. Trading involves substantial risk.
        </p>
      </main>

      <footer className="border-t border-border/60 mt-24">
        <div className="mx-auto max-w-6xl px-6 py-6 text-xs text-muted-foreground flex justify-between">
          <span>© {new Date().getFullYear()} NeurlX</span>
          <span className="font-mono">paper-trading · v0.1</span>
        </div>
      </footer>
    </div>
  );
}

const FEATURES = [
  { icon: Shield, title: "Encrypted credentials",
    body: "API keys stored with AES-256-GCM. Read-only by default. Trading permission is an explicit toggle you own." },
  { icon: GitBranch, title: "Modular connector layer",
    body: "One typed interface — new exchanges drop in without touching the engine. Paper connector ships today." },
  { icon: Zap, title: "AI signals with rationale",
    body: "Every signal shows entry, SL, TP, confidence, and human-readable reasoning. No black boxes." },
  { icon: Lock, title: "Multi-layer risk gate",
    body: "Confidence floor, position size, daily loss cap, trade count, asset whitelist — checked before every fill." },
  { icon: LineChart, title: "Live P&L & analytics",
    body: "Portfolio value, realized/unrealized P&L, win rate, drawdown, and per-trade journal with full audit log." },
  { icon: TerminalSquare, title: "Emergency kill switch",
    body: "One click halts all automated trading, cancels pending signals, and blocks new executions." },
];
