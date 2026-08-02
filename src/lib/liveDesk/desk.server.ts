// Live trading desk — reads real broker state (MetaTrader via MetaApi) and
// merges it with NeurlX's own records (AI confidence, strategy, exit reasons).
//
// Everything here is server-only; the thin server-function wrappers live in
// src/lib/liveDesk.functions.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AccountSummary, ClosedDeal, RichPosition, TradingConnector,
} from "@/lib/connectors/types";

export interface DeskAccount {
  connectionId: string;
  label: string;
  connectorId: string;
  summary: AccountSummary | null;
  error?: string;
}

export interface DeskPosition extends Omit<RichPosition, "raw"> {
  connectionId: string;
  accountLabel: string;
  currency: string;
  profitPct: number;
  aiConfidence: number | null;
  strategy: string | null;
  neurlxPositionId: string | null;
  /** "ai" while the profit-protection engine owns the levels, "manual" after an override. */
  slTpMode: "ai" | "manual";
  /** Levels the AI calculated — kept visible even when the user overrides them. */
  aiStopLoss: number | null;
  aiTakeProfit: number | null;
}


export interface DeskClosedTrade extends ClosedDeal {
  connectionId: string;
  accountLabel: string;
  holdingSeconds: number | null;
  outcome: "win" | "loss" | "flat";
  exitReason: string;
  strategy: string | null;
}

const MT_VENUES = new Set(["mt5", "mt4"]);

async function buildConnector(
  supabase: SupabaseClient,
  userId: string,
  conn: { id: string; connector_id: string; credential_ciphertext: string | null },
): Promise<TradingConnector | null> {
  try {
    const { decryptJSON } = await import("@/lib/crypto.server");
    const { createConnector } = await import("@/lib/connectors/factory.server");
    const creds = conn.credential_ciphertext
      ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext)
      : {};
    return createConnector(conn.connector_id, creds, {
      supabase, userId, connectionId: conn.id,
    });
  } catch {
    return null;
  }
}

async function liveConnections(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase.from("exchange_connections")
    .select("id,label,connector_id,status,read_enabled,credential_ciphertext")
    .eq("user_id", userId).neq("connector_id", "paper");
  return (data ?? []).filter(c => c.status === "connected");
}

function isMtLike(connectorId: string, brokerCategory?: string | null): boolean {
  return MT_VENUES.has(connectorId) || brokerCategory === "mt";
}

/** Realized P/L over a window, straight from the broker's closed deals. */
function realizedSince(deals: DeskClosedTrade[], sinceMs: number): number {
  return deals
    .filter(d => +new Date(d.closedAt) >= sinceMs)
    .reduce((s, d) => s + d.netProfit, 0);
}

export interface LiveDeskSnapshot {
  accounts: DeskAccount[];
  totals: {
    currency: string;
    balance: number;
    equity: number;
    freeMargin: number;
    usedMargin: number;
    marginLevel: number | null;
    unrealizedPnl: number;
    realizedTotal: number;
    dailyPnl: number;
    weeklyPnl: number;
    monthlyPnl: number;
  };
  positions: DeskPosition[];
  closed: DeskClosedTrade[];
  marginPaused: boolean;
  minFreeMarginPct: number;
  hasLiveAccounts: boolean;
}

export async function loadLiveDesk(
  supabase: SupabaseClient,
  userId: string,
): Promise<LiveDeskSnapshot> {
  const conns = await liveConnections(supabase, userId);

  const [{ data: settings }, { data: dbPositions }, { data: strategies }] = await Promise.all([
    supabase.from("automation_settings")
      .select("min_free_margin_pct, margin_pause_active").eq("user_id", userId).maybeSingle(),
    supabase.from("positions").select("*").eq("user_id", userId)
      .order("opened_at", { ascending: false }).limit(300),
    supabase.from("strategies").select("id,name").eq("user_id", userId),
  ]);
  const strategyName = new Map<string, string>(
    (strategies ?? []).map(s => [s.id as string, s.name as string]),
  );

  const accounts: DeskAccount[] = [];
  const positions: DeskPosition[] = [];
  const closed: DeskClosedTrade[] = [];

  for (const c of conns) {
    if (!isMtLike(c.connector_id)) continue;
    const connector = await buildConnector(supabase, userId, c);
    if (!connector?.getAccountSummary) continue;

    const [summary, rich, deals] = await Promise.all([
      connector.getAccountSummary().catch(() => null),
      connector.getRichPositions?.().catch(() => []) ?? Promise.resolve([]),
      connector.getClosedDeals?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    accounts.push({
      connectionId: c.id, label: c.label, connectorId: c.connector_id, summary,
    });
    const currency = summary?.currency ?? "USD";

    for (const p of rich) {
      const match = (dbPositions ?? []).find(d =>
        (d.external_position_id && String(d.external_position_id) === p.ticket)
        || (d.status === "open"
          && String(d.broker_symbol ?? d.symbol).toUpperCase().replace(/[^A-Z0-9]/g, "")
            === p.symbol.toUpperCase().replace(/[^A-Z0-9]/g, "")
          && (d.side === "long") === (p.side === "long")),
      );
      const notional = p.openPrice * p.volume;
      const { raw: _raw, ...plain } = p;
      void _raw;
      positions.push({
        ...plain,
        connectionId: c.id,
        accountLabel: c.label,
        currency,
        profitPct: notional > 0 ? (p.profit / Math.max(notional, 1e-9)) * 100 : 0,
        aiConfidence: match?.ai_confidence != null ? Number(match.ai_confidence) : null,
        strategy: match?.strategy_id ? strategyName.get(match.strategy_id) ?? "AI committee" : "AI committee",
        neurlxPositionId: match?.id ?? null,
      });
    }

    for (const d of deals) {
      const match = (dbPositions ?? []).find(x =>
        x.external_position_id && d.positionTicket
        && String(x.external_position_id) === d.positionTicket,
      );
      const holdingSeconds = d.openedAt
        ? Math.max(0, Math.round((+new Date(d.closedAt) - +new Date(d.openedAt)) / 1000))
        : null;
      closed.push({
        ...d,
        connectionId: c.id,
        accountLabel: c.label,
        holdingSeconds,
        outcome: d.netProfit > 0 ? "win" : d.netProfit < 0 ? "loss" : "flat",
        exitReason: resolveExitReason(match?.exit_reason as string | undefined, d.comment ?? null),
        strategy: match?.strategy_id ? strategyName.get(match.strategy_id) ?? null : null,
      });
    }
  }

  closed.sort((a, b) => +new Date(b.closedAt) - +new Date(a.closedAt));

  const now = Date.now();
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const totals = {
    currency: accounts[0]?.summary?.currency ?? "USD",
    balance: sum(accounts, a => a.summary?.balance ?? 0),
    equity: sum(accounts, a => a.summary?.equity ?? 0),
    freeMargin: sum(accounts, a => a.summary?.freeMargin ?? 0),
    usedMargin: sum(accounts, a => a.summary?.usedMargin ?? 0),
    marginLevel: null as number | null,
    unrealizedPnl: positions.reduce((s, p) => s + p.profit + p.swap + p.commission, 0),
    realizedTotal: closed.reduce((s, d) => s + d.netProfit, 0),
    dailyPnl: realizedSince(closed, +startOfDay),
    weeklyPnl: realizedSince(closed, now - 7 * 864e5),
    monthlyPnl: realizedSince(closed, now - 30 * 864e5),
  };
  totals.marginLevel = totals.usedMargin > 0
    ? Number(((totals.equity / totals.usedMargin) * 100).toFixed(2)) : null;

  return {
    accounts, positions, closed, totals,
    marginPaused: (settings as { margin_pause_active?: boolean } | null)?.margin_pause_active === true,
    minFreeMarginPct: Number((settings as { min_free_margin_pct?: number } | null)?.min_free_margin_pct ?? 20),
    hasLiveAccounts: accounts.length > 0,
  };
}

function sum<T>(items: T[], pick: (t: T) => number): number {
  return Number(items.reduce((s, i) => s + (pick(i) || 0), 0).toFixed(2));
}

function resolveExitReason(dbReason: string | undefined, comment: string | null): string {
  const source = `${dbReason ?? ""} ${comment ?? ""}`.toLowerCase();
  if (/\[tp\]|take_?profit/.test(source)) return "Take Profit";
  if (/\[sl\]|stop_?loss/.test(source)) return "Stop Loss";
  if (/trail/.test(source)) return "Trailing Stop";
  if (/breaker|kill/.test(source)) return "Circuit Breaker";
  if (/manual/.test(source)) return "Manual";
  if (/ai|signal|committee/.test(source)) return "AI Exit";
  return dbReason ? dbReason.replace(/_/g, " ") : "Broker close";
}

// ---------------------------------------------------------------------------
// Strategy analytics
// ---------------------------------------------------------------------------
export interface StrategyAnalytics {
  strategy: string;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  sharpe: number;
  maxDrawdown: number;
  profitFactor: number;
  avgHoldingSeconds: number;
  netProfit: number;
}

export function analyzeTrades(
  trades: Array<{ strategy: string | null; netProfit: number; holdingSeconds: number | null }>,
): StrategyAnalytics[] {
  const groups = new Map<string, typeof trades>();
  for (const t of trades) {
    const key = t.strategy ?? "AI committee";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const out: StrategyAnalytics[] = [];
  for (const [strategy, list] of groups) {
    const wins = list.filter(t => t.netProfit > 0);
    const losses = list.filter(t => t.netProfit < 0);
    const grossWin = wins.reduce((s, t) => s + t.netProfit, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netProfit, 0));
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const winRate = list.length ? wins.length / list.length : 0;
    const returns = list.map(t => t.netProfit);
    const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1) : 0;
    const sd = Math.sqrt(variance);

    // Max drawdown of the cumulative net-profit curve.
    let peak = 0, cum = 0, maxDd = 0;
    for (const r of [...returns].reverse()) {
      cum += r;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
    }

    out.push({
      strategy,
      trades: list.length,
      winRate: Number((winRate * 100).toFixed(2)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      expectancy: Number((winRate * avgWin - (1 - winRate) * avgLoss).toFixed(2)),
      sharpe: sd > 0 ? Number(((mean / sd) * Math.sqrt(list.length)).toFixed(2)) : 0,
      maxDrawdown: Number(maxDd.toFixed(2)),
      profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
      avgHoldingSeconds: Math.round(
        list.reduce((s, t) => s + (t.holdingSeconds ?? 0), 0) / Math.max(list.length, 1),
      ),
      netProfit: Number(list.reduce((s, t) => s + t.netProfit, 0).toFixed(2)),
    });
  }
  return out.sort((a, b) => b.netProfit - a.netProfit);
}

// ---------------------------------------------------------------------------
// Portfolio view
// ---------------------------------------------------------------------------
export interface PortfolioOverview {
  equity: number;
  floatingPnl: number;
  realizedPnl: number;
  cumulativeReturnPct: number;
  equityCurve: Array<{ ts: string; equity: number }>;
  exposureByAsset: Array<{ symbol: string; notional: number; pct: number }>;
  exposureByDirection: { long: number; short: number; netPct: number };
  openPositions: DeskPosition[];
}

export function buildPortfolio(snapshot: LiveDeskSnapshot): PortfolioOverview {
  const equity = snapshot.totals.equity;
  const floatingPnl = snapshot.totals.unrealizedPnl;
  const realizedPnl = snapshot.totals.realizedTotal;

  // Equity curve reconstructed backwards from today's equity using closed P/L.
  const ordered = [...snapshot.closed].sort((a, b) => +new Date(a.closedAt) - +new Date(b.closedAt));
  const startEquity = equity - realizedPnl - floatingPnl;
  let running = startEquity;
  const equityCurve = ordered.map(d => {
    running += d.netProfit;
    return { ts: d.closedAt, equity: Number(running.toFixed(2)) };
  });
  equityCurve.push({ ts: new Date().toISOString(), equity: Number(equity.toFixed(2)) });

  const byAsset = new Map<string, number>();
  let long = 0, short = 0;
  for (const p of snapshot.positions) {
    const notional = Math.abs(p.openPrice * p.volume);
    byAsset.set(p.symbol, (byAsset.get(p.symbol) ?? 0) + notional);
    if (p.side === "long") long += notional; else short += notional;
  }
  const grossExposure = long + short;
  const exposureByAsset = [...byAsset.entries()]
    .map(([symbol, notional]) => ({
      symbol,
      notional: Number(notional.toFixed(2)),
      pct: grossExposure > 0 ? Number(((notional / grossExposure) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.notional - a.notional);

  return {
    equity, floatingPnl, realizedPnl,
    cumulativeReturnPct: startEquity > 0
      ? Number((((equity - startEquity) / startEquity) * 100).toFixed(2)) : 0,
    equityCurve,
    exposureByAsset,
    exposureByDirection: {
      long: Number(long.toFixed(2)),
      short: Number(short.toFixed(2)),
      netPct: grossExposure > 0 ? Number((((long - short) / grossExposure) * 100).toFixed(2)) : 0,
    },
    openPositions: snapshot.positions,
  };
}
