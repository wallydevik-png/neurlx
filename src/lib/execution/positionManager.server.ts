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
  const paper = createPaperConnector();
  const q = await paper.getQuote(pos.symbol);
  const price = pos.side === "long" ? q.bid : q.ask;
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
  const paper = createPaperConnector();
  const q = await paper.getQuote(pos.symbol);
  const exitPrice = pos.side === "long" ? q.bid : q.ask;
  const dir = pos.side === "long" ? 1 : -1;
  const pnl = (exitPrice - Number(pos.avg_entry)) * dir * reduceQty;
  const fees = exitPrice * reduceQty * 0.001;

  // Record partial-exit order
  await supabase.from("orders").insert({
    user_id: userId, account_id: pos.account_id, position_id: pos.id,
    symbol: pos.symbol, side: pos.side === "long" ? "sell" : "buy", qty: reduceQty,
    order_type: "market", status: "filled", filled_price: exitPrice,
    fees, slippage_bps: 5, filled_at: new Date().toISOString(),
  });
  const newQty = +(Number(pos.qty) - reduceQty).toFixed(8);
  await supabase.from("positions").update({ qty: newQty }).eq("id", positionId);
  // Return proceeds to cash
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

  // Risk gate: total notional must respect max_trade_size
  const { data: settings } = await supabase.from("automation_settings").select("*")
    .eq("user_id", userId).maybeSingle();
  const paper = createPaperConnector();
  const q = await paper.getQuote(pos.symbol);
  const entry = pos.side === "long" ? q.ask : q.bid;
  const newTotalNotional = entry * (Number(pos.qty) + addQty);
  if (settings && newTotalNotional > Number(settings.max_trade_size)) {
    throw new Error(`Adding would exceed max trade size ($${settings.max_trade_size}).`);
  }
  const fees = entry * addQty * 0.001;

  // Debit cash + record order
  const { data: acct } = await supabase.from("paper_accounts").select("*")
    .eq("id", pos.account_id).maybeSingle();
  if (!acct) throw new Error("No account");
  if (Number(acct.cash_balance) < entry * addQty + fees) {
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
): Promise<{ actions: number }> {
  const { data: positions } = await supabase.from("positions").select("*")
    .eq("user_id", userId).eq("status", "open");
  if (!positions?.length) return { actions: 0 };

  const paper = createPaperConnector();
  let actions = 0;

  for (const p of positions) {
    if (!p.stop_loss) continue;
    const q = await paper.getQuote(p.symbol);
    const mark = q.mid;
    const dir = p.side === "long" ? 1 : -1;
    const r = Math.abs(Number(p.avg_entry) - Number(p.stop_loss));
    if (r <= 0) continue;
    const rMultiple = ((mark - Number(p.avg_entry)) * dir) / r;

    // 1. Break-even move at 1R
    if (!p.break_even_moved && rMultiple >= 1) {
      const newStop = Number(p.avg_entry);
      // Only move if it's strictly better than current stop
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

    // 4. Stop-loss hit → auto-close
    const stopHit = dir === 1 ? mark <= Number(p.stop_loss) : mark >= Number(p.stop_loss);
    const tpHit = p.take_profit &&
      (dir === 1 ? mark >= Number(p.take_profit) : mark <= Number(p.take_profit));
    if (stopHit || tpHit) {
      // Trigger the same close path used by manual close
      const reason = stopHit ? "stop_loss" : "take_profit";
      const { closePositionInternal } = await import("./closePosition.server");
      await closePositionInternal(supabase, userId, p.id, reason);
      actions++;
    }
  }

  return { actions };
}
