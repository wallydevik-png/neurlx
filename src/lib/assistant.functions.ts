// Personal Assistant server functions. Uses Lovable AI Gateway.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-2.5-flash";

export const listConversations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("assistant_conversations")
      .select("id,title,created_at,updated_at")
      .eq("user_id", context.userId)
      .order("updated_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { conversations: data ?? [] };
  });

export const getConversation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ conversationId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    const [convoRes, msgsRes] = await Promise.all([
      context.supabase.from("assistant_conversations").select("*")
        .eq("id", data.conversationId).eq("user_id", context.userId).maybeSingle(),
      context.supabase.from("assistant_messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", data.conversationId).eq("user_id", context.userId)
        .order("created_at", { ascending: true }),
    ]);
    if (!convoRes.data) throw new Error("Conversation not found");
    return { conversation: convoRes.data, messages: msgsRes.data ?? [] };
  });

export const createConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ title: z.string().max(120).optional() }).parse(d ?? {}))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("assistant_conversations")
      .insert({ user_id: context.userId, title: data.title ?? "New chat" })
      .select().single();
    if (error) throw new Error(error.message);
    return { conversation: row };
  });

export const deleteConversation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ conversationId: z.string().uuid() }).parse(d))
  .handler(async ({ context, data }) => {
    await context.supabase.from("assistant_conversations")
      .delete().eq("id", data.conversationId).eq("user_id", context.userId);
    return { ok: true };
  });

async function buildContextSnapshot(supabase: any, userId: string) {
  const [acctR, openR, closedR, settingsR, connR, signalsR, notifR] = await Promise.all([
    supabase.from("paper_accounts").select("balance,equity,currency").eq("user_id", userId).maybeSingle(),
    supabase.from("positions").select("symbol,side,qty,entry_price,unrealized_pnl,stop_loss,take_profit")
      .eq("user_id", userId).eq("status", "open").limit(50),
    supabase.from("positions").select("symbol,realized_pnl,closed_at")
      .eq("user_id", userId).eq("status", "closed")
      .order("closed_at", { ascending: false }).limit(30),
    supabase.from("automation_settings").select("mode,kill_switch_active,max_trade_size,daily_loss_limit")
      .eq("user_id", userId).maybeSingle(),
    supabase.from("exchange_connections").select("label,connector_id,status,trading_enabled")
      .eq("user_id", userId),
    supabase.from("signals").select("symbol,action,confidence,rationale,created_at")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(10),
    supabase.from("notifications").select("title,severity,created_at")
      .eq("user_id", userId).is("read_at", null).order("created_at", { ascending: false }).limit(10),
  ]);
  const closed = closedR.data ?? [];
  const realized = closed.reduce((s: number, r: any) => s + Number(r.realized_pnl ?? 0), 0);
  const wins = closed.filter((r: any) => Number(r.realized_pnl) > 0).length;
  return {
    account: acctR.data,
    openPositions: openR.data ?? [],
    recentClosed: closed.slice(0, 10),
    metrics: { realizedPnl: realized, closedCount: closed.length, winRate: closed.length ? wins / closed.length : 0 },
    settings: settingsR.data,
    connections: connR.data ?? [],
    recentSignals: signalsR.data ?? [],
    unreadNotifications: notifR.data ?? [],
    timestamp: new Date().toISOString(),
  };
}

function systemPrompt(ctx: any): string {
  return [
    "You are NeurlX Assistant, an AI copilot inside the NeurlX trading platform.",
    "Tagline: Neural precision, executed.",
    "You help the user understand their trading data, explain AI decisions, and guide them through platform features.",
    "You are NOT a licensed financial advisor. Never guarantee profits. Always mention risk when discussing trades.",
    "Answer using the LIVE USER CONTEXT below. Cite specific numbers (P&L, positions, win rate) when relevant.",
    "If asked to place, close, or modify trades, tell the user you can guide them but they must execute via the appropriate page (Positions, Approvals, Autonomous).",
    "Be concise, direct, and use markdown when helpful.",
    "",
    "LIVE USER CONTEXT (JSON):",
    "```json",
    JSON.stringify(ctx, null, 2).slice(0, 8000),
    "```",
  ].join("\n");
}

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({
      conversationId: z.string().uuid(),
      message: z.string().min(1).max(4000),
    }).parse(d),
  )
  .handler(async ({ context, data }) => {
    const { supabase, userId } = context;
    // Verify ownership
    const convo = await supabase.from("assistant_conversations").select("id,title")
      .eq("id", data.conversationId).eq("user_id", userId).maybeSingle();
    if (!convo.data) throw new Error("Conversation not found");

    // Persist user message
    await supabase.from("assistant_messages").insert({
      conversation_id: data.conversationId, user_id: userId, role: "user", content: data.message,
    });

    // Build live context
    const ctx = await buildContextSnapshot(supabase, userId);

    // Fetch recent history (last 12 msgs)
    const hist = await supabase.from("assistant_messages")
      .select("role,content").eq("conversation_id", data.conversationId)
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(12);
    const history = (hist.data ?? []).reverse();

    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("AI gateway not configured");

    const messages = [
      { role: "system", content: systemPrompt(ctx) },
      ...history.map((m: any) => ({ role: m.role, content: m.content })),
    ];

    let assistantText = "";
    try {
      const res = await fetch(AI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: DEFAULT_MODEL, messages }),
      });
      if (res.status === 429) throw new Error("Rate limit reached. Please try again shortly.");
      if (res.status === 402) throw new Error("AI credits exhausted. Please top up in Lovable Cloud.");
      if (!res.ok) throw new Error(`AI gateway error: ${res.status}`);
      const json: any = await res.json();
      assistantText = json?.choices?.[0]?.message?.content ?? "";
      if (!assistantText) throw new Error("Empty response from AI");
    } catch (e: any) {
      assistantText = `⚠️ ${e.message ?? "Assistant unavailable"}`;
    }

    // Persist assistant message + snapshot
    const inserted = await supabase.from("assistant_messages").insert({
      conversation_id: data.conversationId, user_id: userId,
      role: "assistant", content: assistantText, context_snapshot: ctx,
    }).select("id,role,content,created_at").single();

    // Title auto-set from first user message
    if (convo.data.title === "New chat") {
      const newTitle = data.message.slice(0, 60);
      await supabase.from("assistant_conversations")
        .update({ title: newTitle, updated_at: new Date().toISOString() })
        .eq("id", data.conversationId).eq("user_id", userId);
    } else {
      await supabase.from("assistant_conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", data.conversationId).eq("user_id", userId);
    }

    return { message: inserted.data };
  });
