// Position Manager — Move Stop, Reduce, Add-to, Close, plus Profit Protection.
// Every mutation writes an execution_log entry (immutable audit trail).
//
// Profit protection rules (deterministic):
//   1. Break-even stop: once unrealized P&L >= 1R, move stop to entry.
//   2. Trailing stop: once unrealized P&L >= 2R, trail stop by trailing_stop_pct
//      (or 1.5% default) from the new high-water mark.
//   3. Partial take-profit: once unrealized P&L >= 3R, close 50% and let
//      the rest run with the trailing stop.
//
// R = |entry - stop|. Rules only fire once each per position (idempotent).

import type { SupabaseClient } from "@supabase/supabase-js";
import { createPaperConnector } from "@/lib/connectors/paper.server";
import {
  resolveUserMt5Connector,
  createMt5MarketDataProvider,
} from "@/lib/marketdata/mt5Provider.server";

/**
 * Real-money position mutations (moving a stop, closing on stop/target,
 * reducing/adding size) must be priced off the user's actual live broker
 * feed — never the paper/synthetic connector, which produces fabricated
 * numbers with no relationship to the real market. If no live connection is
 * available, callers should skip the action for that position this cycle
 * rather than act on a fake price. Returns null (not a fake number) when no
 * live price could be obtained.
 */
async function getLiveMarkPrice(
  supabase: SupabaseClient, userId: string, symbol: string,
): Promise<number | null> {
  const connector = await resolveUserMt5Connector(supabase, userId);
  const provider = connector ? createMt5MarketDataProvider(connector) : null;
  if (!provider) return null;
  try {
    return await provider.getLastPrice(symbol);
  } catch {
    return null;
  }
}

async function logEvent(
  supabase: SupabaseClient, userId: string, positionId: string,
  event: string, message: string, payload: Record<string, unknown> = {},
  severity: "info" | "warn" | "error" | "critical" = "info",
) {
  await supabase.from("execution_log").insert({
    user_id: userId, position_id: positionId, event, severity, message, payload,
  });
}

// ---------------------------------------------------------------------------
// Manual position mutations
// ---------------------------------------------------------------------------
export async function moveStopLoss(
  supabase: SupabaseClient, userId: string, positionId: string, newStop: number,
) {
  const { data: pos } = await supabase.from("positions").select("*")
    .eq("id", positionId).eq("user_id", userId).maybeSingle();
  if (!pos || pos.status !== "open") throw new Error("Position not open");

  // SAFETY: never allow removing the stop or moving it into a worse position.
  if (!newStop || newStop <= 0) throw new Error("Stop loss is required — cannot remove it.");
  const dir = pos.side === "long" ? 1 : -1;
  const { data: ticket } = await supabase.from("broker_trade_tickets")
    .select("id").eq("position_id", pos.id).eq("state", "open").limit(1).maybeSingle();
  let price: number;
  if (ticket) {
    const live = await getLiveMarkPrice(supabase, userId, pos.symbol);
    if (live == null) throw new Error("No live price available — cannot safely validate this stop move right now.");
    price = live;
  } else {
    const paper = createPaperConnector();
    const q = await paper.getQuote(pos.symbol);
    price = pos.side === "long" ? q.bid : q.ask;
  }
  // For a long, stop must be BELOW current price; for a short, ABOVE.
  if (dir === 1 && newStop >= price) throw new Error("Stop must be below current price for a long.");
  if (dir === -1 && newStop <= price) throw new Error("Stop must be above current price for a short.");

  await supabase.from("positions").update({ stop_loss: newStop }).eq("id", positionId);
  await logEvent(supabase, userId, positionId, "position.stop_moved",
    `Stop moved from ${pos.stop_loss} to ${newStop}`,
    { previous: pos.stop_loss, next: newStop, price });
  return { ok: true };
}

export async function reducePosition(
  supabase: SupabaseClient, userId: string, positionId: string, reduceQty: number,
) {
  const { data: pos } = await supabase.from("positions").select("*")
    .eq("id", positionId).eq("user_id", userId).maybeSingle();
  if (!pos || pos.status !== "open") throw new Error("Position not open");
  if (reduceQty <= 0 || reduceQty >= Number(pos.qty)) {
    throw new Error("Reduce quantity must be > 0 and < position size (use Close for full exit).");
  }

  // Same live-vs-paper split as closePositionInternal, and using the same
  // shared helper: a position can have more than one open broker ticket
  // (e.g. after a scale-in via addToPosition), so this must reduce across
  // all of them, not just whichever one happened to be most recent.
  const { closeLiveTickets } = await import("./closePosition.server");
  const result = await closeLiveTickets(supabase, userId, pos.id, pos.symbol, reduceQty);

  let exitPrice: number;
  let actualReduceQty = reduceQty;
  if (result.hadLiveTickets) {
    if (result.closedVolume <= 0) {
      throw new Error("Could not reduce the live position on the broker — see execution_log for details.");
    }
    if (!result.allSucceeded || result.closedVolume < reduceQty - 1e-9) {
      // Partial success: only trust what actually happened on the broker,
      // don't pretend the full requested amount was reduced.
      actualReduceQty = result.closedVolume;
    }
    exitPrice = result.weightedExitPrice!;
  } else {
    const paper = createPaperConnector();
    const q = await paper.getQuote(pos.symbol);
    exitPrice = pos.side === "long" ? q.bid : q.ask;
  }

  const dir = pos.side === "long" ? 1 : -1;
  const pnl = (exitPrice - Number(pos.avg_entry)) * dir * actualReduceQty;
  const fees = exitPrice * actualReduceQty * 0.001;

  // Record partial-exit order
  await supabase.from("orders").insert({
    user_id: userId, account_id: pos.account_id, position_id: pos.id,
    symbol: pos.symbol, side: pos.side === "long" ? "sell" : "buy", qty: actualReduceQty,
    order_type: "market", status: "filled", filled_price: exitPrice,
    fees, slippage_bps: 5, filled_at: new Date().toISOString(),
  });
  const newQty = +(Number(pos.qty) - actualReduceQty).toFixed(8);
  await supabase.from("positions").update({ qty: newQty }).eq("id", positionId);
  // Return proceeds to cash — paper/legacy bookkeeping only; a live account's
  // real balance comes straight from the broker, unaffected by this.
  const { data: acct } = await supabase.from("paper_accounts").select("*")
    .eq("id", pos.account_id).maybeSingle();
  if (acct) {
    await supabase.from("paper_accounts").update({
      cash_balance: Number(acct.cash_balance) + exitPrice * reduceQty - fees,
      realized_pnl: Number(acct.realized_pnl ?? 0) + pnl - fees,
    }).eq("id", acct.id);
  }
  await logEvent(supabase, userId, positionId, "position.reduced",
    `Reduced by ${reduceQty} at ${exitPrice} (P&L ${pnl.toFixed(2)})`,
    { reduceQty, exitPrice, pnl, fees });
  return { ok: true, pnl };
}

export async function addToPosition(
  supabase: SupabaseClient, userId: string, positionId: string, addQty: number,
) {
  const { data: pos } = await supabase.from("positions").select("*")
    .eq("id", positionId).eq("user_id", userId).maybeSingle();
  if (!pos || pos.status !== "open") throw new Error("Position not open");
  if (addQty <= 0) throw new Error("Add quantity must be positive.");

  const { data: settings } = await supabase.from("automation_settings").select("*")
    .eq("user_id", userId).maybeSingle();

  // Is this a live position? Check for any existing open broker ticket.
  const { data: existingTicket } = await supabase.from("broker_trade_tickets")
    .select("id,connection_id").eq("position_id", pos.id).eq("state", "open").limit(1).maybeSingle();

  let entry: number;
  let fees: number;

  if (existingTicket?.connection_id) {
    // Live position — this must place a REAL order on the broker to
    // actually increase exposure, not just edit a number in our database
    // while the real position stays whatever size it already was.
    const { data: conn } = await supabase.from("exchange_connections")
      .select("id,connector_id,status,trading_enabled,credential_ciphertext")
      .eq("id", existingTicket.connection_id).eq("user_id", userId).maybeSingle();
    if (!conn || conn.status !== "connected" || !conn.trading_enabled) {
      throw new Error("Live broker connection unavailable — refusing to add to a real position blind.");
    }
    const { decryptJSON } = await import("@/lib/crypto.server");
    const { createConnector } = await import("@/lib/connectors/factory.server");
    const creds = conn.credential_ciphertext
      ? await decryptJSON<Record<string, string>>(conn.credential_ciphertext) : {};
    const connector = createConnector(conn.connector_id, creds, { supabase, userId, connectionId: conn.id });

    const { fetchLastPrice } = await import("@/lib/marketdata/service.server");
    const markBeforeOrder = await fetchLastPrice(pos.symbol, userId, supabase);
    if (settings) {
      await assertRiskBudget(supabase, userId, pos, addQty, markBeforeOrder);
    }


    const result = await connector.placeOrder({
      symbol: pos.symbol, side: pos.side === "long" ? "buy" : "sell",
      qty: addQty, orderType: "market",
    });
    if (result.status === "rejected") {
      throw new Error(`Broker rejected the add-to-position order (${pos.symbol}). See execution_log/order raw response for details.`);
    }
    entry = result.filledPrice ?? markBeforeOrder;
    fees = Number(result.fees ?? entry * addQty * 0.001);

    // This is a separate broker ticket from the original entry (MT5 doesn't
    // merge fills into one ticket the way our own position record does) —
    // record it as its own broker_trade_tickets row against the same
    // NeurlX position, so a future close/reduce finds and closes it too.
    await supabase.from("broker_trade_tickets").insert({
      user_id: userId, connection_id: existingTicket.connection_id, position_id: pos.id,
      venue: "mt5", broker_symbol: pos.symbol, requested_symbol: pos.symbol,
      side: pos.side === "long" ? "buy" : "sell", volume: addQty,
      metaapi_order_id: result.externalOrderId, broker_position_ticket: result.externalOrderId,
      state: "open", detail: { via: "addToPosition" },
    });
  } else {
    // No live ticket — genuine paper position, existing simulated behavior.
    const paper = createPaperConnector();
    const q = await paper.getQuote(pos.symbol);
    entry = pos.side === "long" ? q.ask : q.bid;
    const newTotalNotional = entry * (Number(pos.qty) + addQty);
    if (settings && newTotalNotional > Number(settings.max_trade_size)) {
      throw new Error(`Adding would exceed max trade size ($${settings.max_trade_size}).`);
    }
    fees = entry * addQty * 0.001;
  }

  // Debit cash + record order — paper/legacy bookkeeping. For a live
  // position, the real balance comes straight from the broker (Live Trading
  // Desk reads MetaApi's account info directly) and is unaffected by this.
  const { data: acct } = await supabase.from("paper_accounts").select("*")
    .eq("id", pos.account_id).maybeSingle();
  if (!acct) throw new Error("No account");
  if (!existingTicket?.connection_id && Number(acct.cash_balance) < entry * addQty + fees) {
    throw new Error("Insufficient paper cash for this add.");
  }
  await supabase.from("orders").insert({
    user_id: userId, account_id: pos.account_id, position_id: pos.id,
    symbol: pos.symbol, side: pos.side === "long" ? "buy" : "sell", qty: addQty,
    order_type: "market", status: "filled", filled_price: entry,
    fees, slippage_bps: 5, filled_at: new Date().toISOString(),
  });
  // Blend average entry
  const newQty = Number(pos.qty) + addQty;
  const newAvg = (Number(pos.avg_entry) * Number(pos.qty) + entry * addQty) / newQty;
  await supabase.from("positions").update({
    qty: newQty, avg_entry: +newAvg.toFixed(8),
  }).eq("id", positionId);
  await supabase.from("paper_accounts").update({
    cash_balance: Number(acct.cash_balance) - entry * addQty - fees,
  }).eq("id", acct.id);
  await logEvent(supabase, userId, positionId, "position.added",
    `Added ${addQty} at ${entry} — new avg ${newAvg.toFixed(4)}`,
    { addQty, entry, newAvg, newQty });
  return { ok: true, newAvg, newQty };
}

// ---------------------------------------------------------------------------
// Profit protection — evaluated per position, idempotent
// ---------------------------------------------------------------------------
export async function runProfitProtection(
  supabase: SupabaseClient, userId: string,
): Promise<{ actions: number; skipped: number }> {
  const { data: positions } = await supabase.from("positions").select("*")
    .eq("user_id", userId).eq("status", "open");
  if (!positions?.length) return { actions: 0, skipped: 0 };

  // Which of these positions are on live broker tickets? Only those may use
  // getLiveMarkPrice; genuine paper positions keep using the paper connector.
  const { data: tickets } = await supabase.from("broker_trade_tickets")
    .select("position_id").eq("state", "open").in("position_id", positions.map(p => p.id));
  const liveIds = new Set((tickets ?? []).map(t => t.position_id));

  let actions = 0;
  let skipped = 0;

  for (const p of positions) {
    // A position needs at least one protective level to be worth checking.
    if (!p.stop_loss && !p.take_profit) continue;

    let markOrNull: number | null;
    if (liveIds.has(p.id)) {
      markOrNull = await getLiveMarkPrice(supabase, userId, p.symbol);
      if (markOrNull == null) {
        // Never decide a real position's fate on a fabricated price — skip
        // this position this cycle and log it, rather than silently using
        // synthetic data to close (or fail to close) a live trade.
        console.warn(`[profitProtection] no live price for ${p.symbol} (user ${userId}) — skipping this cycle`);
        skipped++;
        continue;
      }
    } else {
      const paper = createPaperConnector();
      markOrNull = (await paper.getQuote(p.symbol)).mid;
    }
    const mark: number = markOrNull;

    const dir = p.side === "long" ? 1 : -1;

    // R-multiple-dependent features (break-even, trailing, partial exits)
    // need a stop distance to mean anything — skip them (not the whole
    // position) when there's no stop-loss set.
    if (p.stop_loss) {
      const r = Math.abs(Number(p.avg_entry) - Number(p.stop_loss));
      if (r > 0) {
        const rMultiple = ((mark - Number(p.avg_entry)) * dir) / r;

        // 1. Break-even move at 1R
        if (!p.break_even_moved && rMultiple >= 1) {
          const newStop = Number(p.avg_entry);
          const better = dir === 1 ? newStop > Number(p.stop_loss) : newStop < Number(p.stop_loss);
          if (better) {
            await supabase.from("positions").update({
              stop_loss: newStop, break_even_moved: true,
            }).eq("id", p.id);
            await logEvent(supabase, userId, p.id, "profit_protect.breakeven",
              `Break-even stop moved to entry ${newStop} at 1R`,
              { rMultiple, prevStop: p.stop_loss, newStop });
            actions++;
          }
        }

        // 2. Trailing stop activation at 2R
        if (rMultiple >= 2) {
          const hw = Number(p.trailing_high_water ?? p.avg_entry);
          const newHw = dir === 1 ? Math.max(hw, mark) : Math.min(hw, mark);
          const trailPct = Number(p.trailing_stop_pct ?? 0.015);
          const trailStop = dir === 1 ? newHw * (1 - trailPct) : newHw * (1 + trailPct);
          const better = dir === 1 ? trailStop > Number(p.stop_loss) : trailStop < Number(p.stop_loss);
          const patch: Record<string, unknown> = {
            trailing_high_water: +newHw.toFixed(8),
          };
          if (!p.trailing_activated_at) patch.trailing_activated_at = new Date().toISOString();
          if (better) patch.stop_loss = +trailStop.toFixed(8);
          await supabase.from("positions").update(patch).eq("id", p.id);
          if (better) {
            await logEvent(supabase, userId, p.id, "profit_protect.trailing",
              `Trailing stop → ${trailStop.toFixed(4)} (high-water ${newHw.toFixed(4)})`,
              { rMultiple, trailPct, newStop: trailStop, highWater: newHw });
            actions++;
          }
        }

        // 3. Scaled partial exits — 30% at 1.5R, another 30% at 2.5R, the
        //    remaining 40% rides the trailing stop.
        const taken = Number(p.partial_take_profit_pct ?? 0);
        const tiers: Array<{ at: number; cumulative: number }> = [
          { at: 1.5, cumulative: 0.3 },
          { at: 2.5, cumulative: 0.6 },
        ];
        for (const tier of tiers) {
          if (rMultiple >= tier.at && taken < tier.cumulative - 1e-9) {
            const originalQty = Number(p.original_qty ?? p.qty);
            const targetClosed = originalQty * tier.cumulative;
            const alreadyClosed = originalQty * taken;
            const slice = +Math.min(
              Math.max(targetClosed - alreadyClosed, 0),
              Number(p.qty) * 0.9,
            ).toFixed(8);
            if (slice > 0) {
              await reducePosition(supabase, userId, p.id, slice);
              await supabase.from("positions").update({
                partial_take_profit_pct: tier.cumulative,
                original_qty: originalQty,
              }).eq("id", p.id);
              await logEvent(supabase, userId, p.id, "profit_protect.partial_tp",
                `Scaled out ${(tier.cumulative * 100).toFixed(0)}% cumulative at ${tier.at}R`,
                { rMultiple, closedQty: slice, tier: tier.at });
              actions++;
            }
            break;
          }
        }
      }
    }

    // 4. Stop-loss or take-profit hit → auto-close. Runs regardless of
    //    whether a stop-loss is set, so a take-profit-only position (e.g.
    //    one where you overrode just the target via the Live Desk) is still
    //    actually enforced instead of being skipped entirely.
    const stopHit = p.stop_loss && (dir === 1 ? mark <= Number(p.stop_loss) : mark >= Number(p.stop_loss));
    const tpHit = p.take_profit &&
      (dir === 1 ? mark >= Number(p.take_profit) : mark <= Number(p.take_profit));
    if (stopHit || tpHit) {
      const reason = stopHit ? "stop_loss" : "take_profit";
      const { closePositionInternal } = await import("./closePosition.server");
      try {
        await closePositionInternal(supabase, userId, p.id, reason);
        actions++;
      } catch (e) {
        // closePositionInternal already logs a critical execution_log entry
        // and leaves the position open on failure — don't let one bad close
        // stop the rest of the batch from being checked.
        console.error(`[profitProtection] close failed for ${p.symbol}`, e);
      }
    }
  }

  return { actions, skipped };
}
