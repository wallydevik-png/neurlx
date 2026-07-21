import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { getMarketIntel, refreshMarketIntel, getIntelOverview, type IntelResult, type OverviewRow, type IntelSignalOut } from "@/lib/intel.functions";
import { listSupportedSymbols } from "@/lib/marketdata/symbols";
import { Radar, RefreshCw, TrendingUp, TrendingDown, Minus, Newspaper, Users, BarChart3, Gauge } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/intel")({
  head: () => ({
    meta: [
      { title: "Market Intelligence — NeurlX" },
      { name: "description", content: "Professional consensus, sentiment, news flow, and social momentum aggregated into a single verdict per symbol." },
    ],
  }),
  loader: () => ({ symbols: listSupportedSymbols() }),
  component: IntelPage,
});

function verdictColor(v: string) {
  if (v.includes("Strong Buy")) return "text-success bg-success/15 border-success/40";
  if (v === "Buy") return "text-success bg-success/10 border-success/30";
  if (v === "Sell") return "text-destructive bg-destructive/10 border-destructive/30";
  if (v.includes("Strong Sell")) return "text-destructive bg-destructive/15 border-destructive/40";
  return "text-muted-foreground bg-secondary/40 border-border";
}

function VerdictBadge({ v }: { v: string }) {
  const Icon = v.includes("Buy") ? TrendingUp : v.includes("Sell") ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${verdictColor(v)}`}>
      <Icon className="w-3.5 h-3.5" /> {v}
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(-1, Math.min(1, score));
  const width = Math.abs(pct) * 50;
  const left = pct >= 0 ? 50 : 50 - width;
  const color = pct >= 0 ? "bg-success" : "bg-destructive";
  return (
    <div className="relative h-2 bg-secondary/40 rounded-full overflow-hidden">
      <div className="absolute inset-y-0" style={{ left: "50%", width: "1px", background: "hsl(var(--border))" }} />
      <div className={`absolute inset-y-0 ${color}`} style={{ left: `${left}%`, width: `${width}%` }} />
    </div>
  );
}

const PROVIDER_META: Record<string, { label: string; icon: any }> = {
  analyst: { label: "Professional Consensus", icon: Gauge },
  sentiment: { label: "Market Sentiment", icon: BarChart3 },
  news: { label: "News Flow", icon: Newspaper },
  social: { label: "Social Momentum", icon: Users },
};

function IntelPage() {
  const { symbols } = Route.useLoaderData();
  const router = useRouter();
  const [symbol, setSymbol] = useState<string>(symbols[0]);
  const fetchIntel = useServerFn(getMarketIntel);
  const fetchOverview = useServerFn(getIntelOverview);
  const refresh = useServerFn(refreshMarketIntel);

  const intelQ = useQuery({
    queryKey: ["intel", symbol],
    queryFn: () => fetchIntel({ data: { symbol } }),
  });
  const overviewQ = useQuery({
    queryKey: ["intel-overview"],
    queryFn: () => fetchOverview(),
    staleTime: 30 * 60_000,
  });

  async function onRefresh() {
    try {
      await refresh({ data: { symbol } });
      toast.success(`Refreshed intelligence for ${symbol}`);
      await router.invalidate();
      intelQ.refetch();
      overviewQ.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    }
  }

  const intel = intelQ.data;
  const consensus = intel?.consensus;

  return (
    <AppShell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/30 grid place-items-center">
            <Radar className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold leading-tight">Market Intelligence</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">Professional consensus · sentiment · news · social momentum.</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={symbol}
              onChange={e => setSymbol(e.target.value)}
              className="h-9 px-3 rounded-md border border-border bg-card text-sm font-mono"
            >
              {symbols.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button
              onClick={onRefresh}
              className="h-9 px-3 rounded-md border border-border hover:bg-secondary/50 text-sm inline-flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          </div>
        </header>

        {/* Consensus card */}
        <section className="rounded-xl border border-border bg-card p-5">
          {intelQ.isLoading || !consensus ? (
            <div className="h-40 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
              <div className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-mono">Consensus</div>
                <div className="text-3xl font-semibold">{symbol}</div>
                <VerdictBadge v={consensus.verdict} />
                <div className="grid grid-cols-2 gap-3 text-sm pt-2">
                  <div>
                    <div className="text-[11px] text-muted-foreground font-mono">Score</div>
                    <div className={`font-mono ${consensus.score >= 0 ? "text-success" : "text-destructive"}`}>
                      {consensus.score >= 0 ? "+" : ""}{consensus.score.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-muted-foreground font-mono">Confidence</div>
                    <div className="font-mono">{Math.round(consensus.confidence * 100)}%</div>
                  </div>
                </div>
                <div className="pt-2"><ScoreBar score={consensus.score} /></div>
                <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                  <span>Bearish</span><span>Neutral</span><span>Bullish</span>
                </div>
              </div>

              <div className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-mono">Provider breakdown</div>
                <div className="space-y-2">
                  {intel!.signals.map((s: IntelSignalOut, i: number) => {
                    const meta = PROVIDER_META[s.provider] ?? { label: s.provider, icon: Gauge };
                    const Icon = meta.icon;
                    return (
                      <div key={i} className="rounded-md border border-border p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Icon className="w-4 h-4 text-primary shrink-0" />
                          <div className="text-sm font-medium">{meta.label}</div>
                          <div className="ml-auto flex items-center gap-3 text-xs font-mono">
                            <span className={s.score >= 0 ? "text-success" : "text-destructive"}>
                              {s.score >= 0 ? "+" : ""}{s.score.toFixed(2)}
                            </span>
                            <span className="text-muted-foreground">conf {Math.round(s.confidence * 100)}%</span>
                          </div>
                        </div>
                        <ScoreBar score={s.score} />
                        <ProviderPayload provider={s.provider} payload={s.payload} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Overview grid */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground font-mono">
            Universe overview · sorted by conviction
          </h2>
          {overviewQ.isLoading ? (
            <div className="h-24 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(overviewQ.data?.overview ?? []).map((row: any) => (
                <button
                  key={row.symbol}
                  onClick={() => setSymbol(row.symbol)}
                  className={`text-left rounded-lg border p-3 hover:bg-secondary/30 transition ${
                    row.symbol === symbol ? "border-primary/50 bg-primary/5" : "border-border bg-card"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono font-semibold">{row.symbol}</div>
                    <VerdictBadge v={row.consensus.verdict} />
                  </div>
                  <div className="mt-2"><ScoreBar score={row.consensus.score} /></div>
                  <div className="mt-1 flex justify-between text-[11px] font-mono text-muted-foreground">
                    <span>{row.consensus.score >= 0 ? "+" : ""}{row.consensus.score.toFixed(2)}</span>
                    <span>conf {Math.round(row.consensus.confidence * 100)}%</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <p className="text-[11px] text-muted-foreground">
          Intelligence signals are informational and cached for 30 minutes. Providers can be replaced with real vendors
          (TipRanks, Benzinga, CryptoPanic, LunarCrush, Santiment) by implementing the <code className="font-mono">IntelProvider</code> interface.
        </p>
      </div>
    </AppShell>
  );
}

function ProviderPayload({ provider, payload }: { provider: string; payload: any }) {
  if (!payload) return null;
  if (provider === "analyst") {
    return (
      <div className="grid grid-cols-4 gap-2 text-[11px] font-mono">
        <Stat label="Buy" value={payload.buys} tone="success" />
        <Stat label="Hold" value={payload.holds} tone="muted" />
        <Stat label="Sell" value={payload.sells} tone="destructive" />
        <Stat label="PT %" value={`${payload.price_target_pct}`} tone="primary" />
      </div>
    );
  }
  if (provider === "sentiment") {
    return (
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="text-muted-foreground">Fear &amp; Greed</span>
        <span>{payload.fear_greed} · {payload.label}</span>
      </div>
    );
  }
  if (provider === "news") {
    return (
      <ul className="space-y-1 text-[11px]">
        {(payload.items ?? []).slice(0, 3).map((it: any, i: number) => (
          <li key={i} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${it.score >= 0 ? "bg-success" : "bg-destructive"}`} />
            <span className="truncate">{it.title}</span>
            <span className="ml-auto text-muted-foreground font-mono shrink-0">{it.source}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (provider === "social") {
    return (
      <div className="flex items-center justify-between text-[11px] font-mono">
        <span className="text-muted-foreground">Mentions 24h · {payload.top_source}</span>
        <span>
          {payload.mentions_24h?.toLocaleString?.() ?? payload.mentions_24h}{" "}
          <span className={payload.mentions_change_pct >= 0 ? "text-success" : "text-destructive"}>
            ({payload.mentions_change_pct >= 0 ? "+" : ""}{payload.mentions_change_pct}%)
          </span>
        </span>
      </div>
    );
  }
  return null;
}

function Stat({ label, value, tone }: { label: string; value: any; tone: "success" | "muted" | "destructive" | "primary" }) {
  const map = {
    success: "text-success", muted: "text-muted-foreground",
    destructive: "text-destructive", primary: "text-primary",
  } as const;
  return (
    <div className="rounded border border-border px-2 py-1">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={map[tone]}>{value}</div>
    </div>
  );
}
