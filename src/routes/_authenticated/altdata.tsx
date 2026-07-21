import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { getAltData, getAltOverview, type AltSignalOut } from "@/lib/altdata.functions";
import { listSupportedSymbols } from "@/lib/marketdata/symbols";
import { Layers3, BookOpen, Percent, TrendingUp, TrendingDown, Minus, Waves, CalendarDays, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/_authenticated/altdata")({
  head: () => ({
    meta: [
      { title: "Alternative Data — NeurlX" },
      { name: "description", content: "Orderbook depth, perp funding, open interest, on-chain flows, and macro calendar aggregated into a single directional read per symbol." },
    ],
  }),
  loader: () => ({ symbols: listSupportedSymbols() }),
  component: AltDataPage,
});

function verdictClass(v: string) {
  if (v.includes("Strong Buy")) return "text-success bg-success/15 border-success/40";
  if (v === "Buy") return "text-success bg-success/10 border-success/30";
  if (v === "Sell") return "text-destructive bg-destructive/10 border-destructive/30";
  if (v.includes("Strong Sell")) return "text-destructive bg-destructive/15 border-destructive/40";
  return "text-muted-foreground bg-secondary/40 border-border";
}
function Verdict({ v }: { v: string }) {
  const I = v.includes("Buy") ? TrendingUp : v.includes("Sell") ? TrendingDown : Minus;
  return <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${verdictClass(v)}`}><I className="w-3.5 h-3.5" /> {v}</span>;
}
function Bar({ score }: { score: number }) {
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

const KIND_META: Record<string, { label: string; icon: any }> = {
  orderbook:     { label: "Orderbook Depth", icon: BookOpen },
  funding:       { label: "Perp Funding",    icon: Percent },
  open_interest: { label: "Open Interest",   icon: Layers3 },
  onchain:       { label: "On-chain Flows",  icon: Waves },
  calendar:      { label: "Macro Calendar",  icon: CalendarDays },
};

function usd(n?: number) {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${n.toFixed(0)}`;
}

function AltDataPage() {
  const { symbols } = Route.useLoaderData();
  const [symbol, setSymbol] = useState<string>(symbols[0]);
  const fetchAlt = useServerFn(getAltData);
  const fetchOverview = useServerFn(getAltOverview);

  const altQ = useQuery({ queryKey: ["altdata", symbol], queryFn: () => fetchAlt({ data: { symbol } }) });
  const overviewQ = useQuery({ queryKey: ["altdata-overview"], queryFn: () => fetchOverview(), staleTime: 5 * 60_000 });

  const composite = altQ.data?.composite;

  return (
    <AppShell>
      <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto space-y-6">
        <header className="flex flex-wrap items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/30 grid place-items-center">
            <Layers3 className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold leading-tight">Alternative Data</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">Orderbook · funding · open interest · on-chain · macro calendar.</p>
          </div>
          <div className="ml-auto">
            <select value={symbol} onChange={e => setSymbol(e.target.value)} className="h-9 px-3 rounded-md border border-border bg-card text-sm font-mono">
              {symbols.map((s: string) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </header>

        <section className="rounded-xl border border-border bg-card p-5">
          {altQ.isLoading || !composite ? (
            <div className="h-40 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-[1fr_2fr]">
              <div className="space-y-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-mono">Composite pressure</div>
                <div className="text-3xl font-semibold">{symbol}</div>
                <Verdict v={composite.verdict} />
                <div className="grid grid-cols-3 gap-3 text-sm pt-2">
                  <div>
                    <div className="text-[11px] text-muted-foreground font-mono">Score</div>
                    <div className={`font-mono ${composite.score >= 0 ? "text-success" : "text-destructive"}`}>
                      {composite.score >= 0 ? "+" : ""}{composite.score.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-muted-foreground font-mono">Conf</div>
                    <div className="font-mono">{Math.round(composite.confidence * 100)}%</div>
                  </div>
                  <div>
                    <div className="text-[11px] text-muted-foreground font-mono">Vol risk</div>
                    <div className={`font-mono ${composite.vol_risk > 0.5 ? "text-warning" : ""}`}>
                      {Math.round(composite.vol_risk * 100)}%
                    </div>
                  </div>
                </div>
                <div className="pt-2"><Bar score={composite.score} /></div>
                <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                  <span>Bearish</span><span>Neutral</span><span>Bullish</span>
                </div>
                {composite.vol_risk > 0.4 && (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[11px] text-warning">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>Elevated event risk over the next 7 days — consider reducing size or tightening stops around high-impact releases.</span>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground font-mono">Signal breakdown</div>
                {(altQ.data?.signals ?? []).map((s: AltSignalOut, i: number) => {
                  const meta = KIND_META[s.kind] ?? { label: s.kind, icon: Layers3 };
                  const Icon = meta.icon;
                  return (
                    <div key={i} className="rounded-md border border-border p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Icon className="w-4 h-4 text-primary shrink-0" />
                        <div className="text-sm font-medium">{meta.label}</div>
                        <div className="ml-auto flex items-center gap-3 text-xs font-mono">
                          {s.kind !== "calendar" && (
                            <span className={s.score >= 0 ? "text-success" : "text-destructive"}>
                              {s.score >= 0 ? "+" : ""}{s.score.toFixed(2)}
                            </span>
                          )}
                          <span className="text-muted-foreground">conf {Math.round(s.confidence * 100)}%</span>
                        </div>
                      </div>
                      {s.kind !== "calendar" && <Bar score={s.score} />}
                      <KindPayload kind={s.kind} payload={s.payload} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground font-mono">Universe pressure · sorted by conviction</h2>
          {overviewQ.isLoading ? (
            <div className="h-24 grid place-items-center text-sm text-muted-foreground">Loading…</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(overviewQ.data?.overview ?? []).map((row: any) => (
                <button key={row.symbol} onClick={() => setSymbol(row.symbol)}
                  className={`text-left rounded-lg border p-3 hover:bg-secondary/30 transition ${row.symbol === symbol ? "border-primary/50 bg-primary/5" : "border-border bg-card"}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-mono font-semibold">{row.symbol}</div>
                    <Verdict v={row.composite.verdict} />
                  </div>
                  <div className="mt-2"><Bar score={row.composite.score} /></div>
                  <div className="mt-1 flex justify-between text-[11px] font-mono text-muted-foreground">
                    <span>{row.composite.score >= 0 ? "+" : ""}{row.composite.score.toFixed(2)}</span>
                    <span>vol {Math.round(row.composite.vol_risk * 100)}%</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <p className="text-[11px] text-muted-foreground">
          Alternative data providers are pluggable. Swap the synthetic modules for Kaiko (orderbook), Coinglass (funding/OI),
          Glassnode (on-chain), or Trading Economics (calendar) by implementing <code className="font-mono">AltDataProvider</code>.
        </p>
      </div>
    </AppShell>
  );
}

function KindPayload({ kind, payload }: { kind: string; payload: any }) {
  if (!payload) return null;
  if (kind === "orderbook") {
    return (
      <div className="grid grid-cols-4 gap-2 text-[11px] font-mono">
        <Stat label="Bid depth" value={`$${usd(payload.bid_depth_usd)}`} tone="success" />
        <Stat label="Ask depth" value={`$${usd(payload.ask_depth_usd)}`} tone="destructive" />
        <Stat label="Imbalance" value={`${payload.imbalance_pct}%`} tone={payload.imbalance_pct >= 0 ? "success" : "destructive"} />
        <Stat label="Spread" value={`${payload.spread_bps} bp`} tone="muted" />
      </div>
    );
  }
  if (kind === "funding") {
    return (
      <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
        <Stat label="Rate 8h" value={`${payload.rate_pct_8h}%`} tone={payload.rate_pct_8h >= 0 ? "success" : "destructive"} />
        <Stat label="APR" value={`${payload.annualized_pct}%`} tone="muted" />
        <Stat label="Regime" value={payload.regime} tone={payload.regime === "Extreme" ? "destructive" : "muted"} />
      </div>
    );
  }
  if (kind === "open_interest") {
    return (
      <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
        <Stat label="OI" value={`$${usd(payload.open_interest_usd)}`} tone="primary" />
        <Stat label="Δ 24h" value={`${payload.change_24h_pct >= 0 ? "+" : ""}${payload.change_24h_pct}%`} tone={payload.change_24h_pct >= 0 ? "success" : "destructive"} />
      </div>
    );
  }
  if (kind === "onchain") {
    return (
      <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
        <Stat label="Exch flow" value={`$${usd(payload.exchange_net_inflow_usd)}`} tone={payload.exchange_net_inflow_usd <= 0 ? "success" : "destructive"} />
        <Stat label="Whale txs" value={payload.whale_txs_24h} tone="muted" />
        <Stat label="Stbl Δ" value={`$${usd(payload.stablecoin_net_supply_usd)}`} tone={payload.stablecoin_net_supply_usd >= 0 ? "success" : "destructive"} />
      </div>
    );
  }
  if (kind === "calendar") {
    return (
      <ul className="space-y-1 text-[11px]">
        {(payload.events ?? []).map((e: any, i: number) => (
          <li key={i} className="flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.impact === "high" ? "bg-destructive" : "bg-warning"}`} />
            <span className="truncate">{e.title}</span>
            <span className="ml-auto text-muted-foreground font-mono shrink-0">{e.when}</span>
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

function Stat({ label, value, tone }: { label: string; value: any; tone: "success" | "muted" | "destructive" | "primary" }) {
  const map = { success: "text-success", muted: "text-muted-foreground", destructive: "text-destructive", primary: "text-primary" } as const;
  return (
    <div className="rounded border border-border px-2 py-1">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className={map[tone]}>{value}</div>
    </div>
  );
}
