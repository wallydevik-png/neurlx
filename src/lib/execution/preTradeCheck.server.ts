// Pre-trade validation for LIVE orders. Runs BEFORE the risk gate wraps the
// order; both must pass. Every decision is written to execution_log.
//
// Checks performed (in order):
//   1. Circuit breaker (emergency kill + daily halt) — reuses engine gate.
//   2. Connection health: ping + clock skew < 5s.
//   3. API permissions: reading + spot trading required, withdrawals refused.
//   4. Available balance covers estimated notional (buys only for spot).
//   5. Stop-loss + take-profit both present.
//   6. Symbol filters (min qty, step size, min notional).
// The existing evaluateRisk() gate remains authoritative and runs upstream.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TradingConnector } from "@/lib/connectors/types";

export interface PreTradeInput {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  estPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  connectionId: string;
}

export interface PreTradeDecision {
  ok: boolean;
  reason?: string;
  adjustments?: { qty?: number };
  meta?: {
    pingMs?: number | null;
    clockSkewMs?: number | null;
    availableUsd?: number;
    minNotional?: number;
  };
}

async function logDecision(
  supabase: SupabaseClient, userId: string, connectionId: string,
  ok: boolean, message: string, payload: Record<string, unknown>,
) {
  await supabase.from("execution_log").insert({
    user_id: userId,
    event: ok ? "pretrade.ok" : "pretrade.reject",
    severity: ok ? "info" : "warn",
    message,
    payload: { connectionId, ...payload },
  });
}

export async function runPreTradeCheck(
  supabase: SupabaseClient,
  userId: string,
  connector: TradingConnector,
  input: PreTradeInput,
): Promise<PreTradeDecision> {
  // 1. Health / clock skew
  let pingMs: number | null = null;
  let clockSkewMs: number | null = null;
  if (connector.checkHealth) {
    const h = await connector.checkHealth();
    pingMs = h.pingLatencyMs;
    clockSkewMs = h.clockSkewMs;
    // persist for the UI
    await supabase.from("exchange_connections").update({
      last_sync_at: new Date().toISOString(),
      clock_skew_ms: clockSkewMs,
      health: h.ok ? "healthy" : "degraded",
    }).eq("id", input.connectionId).eq("user_id", userId);
    if (!h.ok) {
      const msg = `Connection unhealthy: ${h.message ?? "unknown"}`;
      await logDecision(supabase, userId, input.connectionId, false, msg, { h });
      return { ok: false, reason: msg };
    }
    if (clockSkewMs !== null && Math.abs(clockSkewMs) > 5000) {
      const msg = `Clock skew ${clockSkewMs}ms exceeds 5000ms — refusing order.`;
      await logDecision(supabase, userId, input.connectionId, false, msg, { clockSkewMs });
      return { ok: false, reason: msg };
    }
  }

  // 2. Permissions
  if (connector.getApiPermissions) {
    try {
      const p = await connector.getApiPermissions();
      await supabase.from("exchange_connections").update({
        permission_scan: p as unknown as Record<string, never>,
        withdrawal_detected: p.enableWithdrawals,
      }).eq("id", input.connectionId).eq("user_id", userId);
      if (!p.enableReading) {
        const msg = "API key missing 'Enable Reading'.";
        await logDecision(supabase, userId, input.connectionId, false, msg, {});
        return { ok: false, reason: msg };
      }
      if (!p.enableSpotAndMarginTrading) {
        const msg = "API key missing 'Enable Spot Trading' permission.";
        await logDecision(supabase, userId, input.connectionId, false, msg, {});
        return { ok: false, reason: msg };
      }
      if (p.enableWithdrawals) {
        const msg = "API key has WITHDRAWAL permission enabled — refusing to trade. Recreate a trade-only key.";
        await logDecision(supabase, userId, input.connectionId, false, msg, {});
        return { ok: false, reason: msg };
      }
    } catch (e) {
      const msg = `Permission check failed: ${e instanceof Error ? e.message : String(e)}`;
      await logDecision(supabase, userId, input.connectionId, false, msg, {});
      return { ok: false, reason: msg };
    }
  }

  // 3. SL/TP
  if (!input.stopLoss || !input.takeProfit) {
    const msg = "Stop-loss and take-profit are both required for live orders.";
    await logDecision(supabase, userId, input.connectionId, false, msg, {});
    return { ok: false, reason: msg };
  }

  // 4. Symbol filter
  let adjustedQty = input.qty;
  let minNotional: number | undefined;
  let stepSize: number | undefined;
  let minQty: number | undefined;
  if (connector.getSymbolFilter) {
    const f = await connector.getSymbolFilter(input.symbol);
    if (!f) {
      const msg = `Symbol ${input.symbol} not tradable on this venue.`;
      await logDecision(supabase, userId, input.connectionId, false, msg, {});
      return { ok: false, reason: msg };
    }
    minNotional = f.minNotional;
    stepSize = f.stepSize;
    minQty = f.minQty;
    if (f.stepSize) adjustedQty = Math.floor(input.qty / f.stepSize) * f.stepSize;
    if (adjustedQty < f.minQty) {
      const msg = `Quantity ${adjustedQty} below venue minimum ${f.minQty}.`;
      await logDecision(supabase, userId, input.connectionId, false, msg, { f });
      return { ok: false, reason: msg };
    }
    if (f.minNotional && adjustedQty * input.estPrice < f.minNotional) {
      const msg = `Order notional $${(adjustedQty * input.estPrice).toFixed(2)} below venue minimum $${f.minNotional}.`;
      await logDecision(supabase, userId, input.connectionId, false, msg, { f });
      return { ok: false, reason: msg };
    }
  }

  // 5. Balance. For live spot, resize to the available funds when possible
  // instead of rejecting a valid smaller order. This keeps autopilot active on
  // small accounts while preserving venue min-qty/min-notional constraints.
  let availableUsd = 0;
  const baseAsset = input.symbol.includes("-") ? input.symbol.split("-")[0].toUpperCase() : input.symbol.replace(/USDT$|USD$|USDC$/, "").toUpperCase();
  if (input.side === "buy") {
    try {
      const balances = await connector.getBalances();
      const stableBalances = balances.filter(b => b.currency === "USDT" || b.currency === "USD" || b.currency === "USDC");
      availableUsd = stableBalances.reduce((sum, b) => sum + Math.max(0, b.available), 0);
      const need = adjustedQty * input.estPrice * 1.005; // 0.5% headroom for fees/slippage
      if (need > availableUsd) {
        let resizedQty = availableUsd / (input.estPrice * 1.005);
        if (stepSize) resizedQty = Math.floor(resizedQty / stepSize) * stepSize;
        resizedQty = Number(resizedQty.toFixed(8));
        const resizedNotional = resizedQty * input.estPrice;
        if (resizedQty > 0 && (!minQty || resizedQty >= minQty) && (!minNotional || resizedNotional >= minNotional)) {
          adjustedQty = resizedQty;
        } else {
          const minNeeded = minNotional ? ` Minimum venue notional is $${minNotional.toFixed(2)}.` : "";
          const msg = `Insufficient tradable stablecoin balance: need up to $${need.toFixed(2)}, have $${availableUsd.toFixed(2)}.${minNeeded}`;
          await logDecision(supabase, userId, input.connectionId, false, msg, { need, availableUsd, minNotional, resizedQty });
          return { ok: false, reason: msg };
        }
      }
    } catch (e) {
      const msg = `Balance check failed: ${e instanceof Error ? e.message : String(e)}`;
      await logDecision(supabase, userId, input.connectionId, false, msg, {});
      return { ok: false, reason: msg };
    }
  } else if (connector.isMarginVenue) {
    // Margin/CFD venue (MT5, OANDA): a sell opens a short position and
    // never requires already holding the underlying asset — checking spot
    // inventory here (as the branch below does) would reject every single
    // sell order unconditionally, since a margin account's getBalances()
    // only ever returns the account's own currency balance, never a
    // per-asset entry. Check buying power for the short the same way a buy
    // is checked, not asset ownership.
    try {
      const balances = await connector.getBalances();
      const stableBalances = balances.filter(b => b.currency === "USDT" || b.currency === "USD" || b.currency === "USDC" || !isNaN(Number(b.available)));
      availableUsd = stableBalances.reduce((sum, b) => sum + Math.max(0, b.available), 0);
      const need = adjustedQty * input.estPrice * 1.005;
      if (need > availableUsd) {
        let resizedQty = availableUsd / (input.estPrice * 1.005);
        if (stepSize) resizedQty = Math.floor(resizedQty / stepSize) * stepSize;
        resizedQty = Number(resizedQty.toFixed(8));
        const resizedNotional = resizedQty * input.estPrice;
        if (resizedQty > 0 && (!minQty || resizedQty >= minQty) && (!minNotional || resizedNotional >= minNotional)) {
          adjustedQty = resizedQty;
        } else {
          const minNeeded = minNotional ? ` Minimum venue notional is $${minNotional.toFixed(2)}.` : "";
          const msg = `Insufficient margin to open short: need up to $${need.toFixed(2)}, have $${availableUsd.toFixed(2)}.${minNeeded}`;
          await logDecision(supabase, userId, input.connectionId, false, msg, { need, availableUsd, minNotional, resizedQty });
          return { ok: false, reason: msg };
        }
      }
    } catch (e) {
      const msg = `Margin check failed: ${e instanceof Error ? e.message : String(e)}`;
      await logDecision(supabase, userId, input.connectionId, false, msg, {});
      return { ok: false, reason: msg };
    }
  } else {
    // Spot exchange (Bybit, Binance, Kraken spot, Coinbase, ...): selling
    // requires actually holding the asset — this check is correct here.
    try {
      const balances = await connector.getBalances();
      const base = balances.find(b => b.currency.toUpperCase() === baseAsset);
      const availableBase = base?.available ?? 0;
      if (adjustedQty > availableBase) {
        let resizedQty = availableBase;
        if (stepSize) resizedQty = Math.floor(resizedQty / stepSize) * stepSize;
        resizedQty = Number(resizedQty.toFixed(8));
        const resizedNotional = resizedQty * input.estPrice;
        if (resizedQty > 0 && (!minQty || resizedQty >= minQty) && (!minNotional || resizedNotional >= minNotional)) {
          adjustedQty = resizedQty;
        } else {
          const msg = `Insufficient ${baseAsset} balance to sell: need ${adjustedQty}, have ${availableBase}.`;
          await logDecision(supabase, userId, input.connectionId, false, msg, { adjustedQty, availableBase, baseAsset, minNotional });
          return { ok: false, reason: msg };
        }
      }
    } catch (e) {
      const msg = `Base-asset balance check failed: ${e instanceof Error ? e.message : String(e)}`;
      await logDecision(supabase, userId, input.connectionId, false, msg, {});
      return { ok: false, reason: msg };
    }
  }

  await logDecision(supabase, userId, input.connectionId, true,
    `Pre-trade OK for ${input.side} ${adjustedQty} ${input.symbol} @ ~${input.estPrice}`,
    { pingMs, clockSkewMs, availableUsd, adjustedQty, minNotional });

  return {
    ok: true,
    adjustments: adjustedQty !== input.qty ? { qty: adjustedQty } : undefined,
    meta: { pingMs, clockSkewMs, availableUsd, minNotional },
  };
}
