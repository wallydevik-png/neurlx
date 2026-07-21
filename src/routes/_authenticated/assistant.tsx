import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/AppShell";
import {
  listConversations, getConversation, createConversation,
  deleteConversation, sendMessage,
} from "@/lib/assistant.functions";
import { Bot, Send, Plus, Trash2, User, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/assistant")({
  component: AssistantPage,
  errorComponent: ({ error }) => (
    <div className="p-6 text-destructive">Failed to load: {error.message}</div>
  ),
  notFoundComponent: () => <div className="p-6">Not found</div>,
});

const SUGGESTIONS = [
  "What is my current P&L and win rate?",
  "Explain my open positions and their risk.",
  "Am I ready to move from Assisted to Autonomous mode?",
  "What does my last AI signal mean?",
];

function AssistantPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listConversations);
  const getFn = useServerFn(getConversation);
  const createFn = useServerFn(createConversation);
  const deleteFn = useServerFn(deleteConversation);
  const sendFn = useServerFn(sendMessage);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const convos = useQuery({ queryKey: ["assistant-convos"], queryFn: () => listFn() });
  const convo = useQuery({
    queryKey: ["assistant-convo", activeId],
    queryFn: () => getFn({ data: { conversationId: activeId! } }),
    enabled: !!activeId,
  });

  const createMut = useMutation({
    mutationFn: () => createFn({ data: {} }),
    onSuccess: (res) => {
      setActiveId(res.conversation.id);
      qc.invalidateQueries({ queryKey: ["assistant-convos"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { conversationId: id } }),
    onSuccess: (_r, id) => {
      if (activeId === id) setActiveId(null);
      qc.invalidateQueries({ queryKey: ["assistant-convos"] });
    },
  });

  const sendMut = useMutation({
    mutationFn: (message: string) =>
      sendFn({ data: { conversationId: activeId!, message } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["assistant-convo", activeId] });
      qc.invalidateQueries({ queryKey: ["assistant-convos"] });
    },
    onError: (e: any) => toast.error(e.message ?? "Send failed"),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [convo.data?.messages?.length, sendMut.isPending]);

  async function handleSend(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg) return;
    let id = activeId;
    if (!id) {
      const created = await createMut.mutateAsync();
      id = created.conversation.id;
    }
    setInput("");
    sendMut.mutate(msg);
  }

  const messages = convo.data?.messages ?? [];

  return (
    <AppShell>
      <PageHeader
        title="Personal Assistant"
        subtitle="Ask NeurlX anything about your trades, signals, or platform features."
        icon={<Sparkles className="h-5 w-5" />}
      />
      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-4 h-[calc(100vh-220px)] min-h-[500px]">
        {/* Sidebar */}
        <div className="border border-border rounded-lg bg-card p-3 flex flex-col overflow-hidden">
          <button
            onClick={() => createMut.mutate()}
            className="w-full flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground py-2 text-sm hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> New chat
          </button>
          <div className="mt-3 flex-1 overflow-y-auto space-y-1">
            {(convos.data?.conversations ?? []).map((c: any) => (
              <div
                key={c.id}
                className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm cursor-pointer ${
                  activeId === c.id ? "bg-accent" : "hover:bg-accent/50"
                }`}
                onClick={() => setActiveId(c.id)}
              >
                <span className="truncate flex-1">{c.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteMut.mutate(c.id); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  aria-label="Delete conversation"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {convos.data?.conversations?.length === 0 && (
              <p className="text-xs text-muted-foreground px-2">No conversations yet.</p>
            )}
          </div>
        </div>

        {/* Chat */}
        <div className="border border-border rounded-lg bg-card flex flex-col overflow-hidden">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {!activeId && (
              <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground">
                <Bot className="h-10 w-10 mb-3 text-primary" />
                <p className="text-lg font-medium text-foreground">How can I help you trade smarter?</p>
                <p className="text-sm mt-1">I know your live positions, P&L, signals, and settings.</p>
                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-xl w-full">
                  {SUGGESTIONS.map(s => (
                    <button
                      key={s}
                      onClick={() => handleSend(s)}
                      className="text-left text-sm border border-border rounded-md p-3 hover:bg-accent"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {activeId && messages.length === 0 && !sendMut.isPending && (
              <p className="text-sm text-muted-foreground">Ask a question to get started.</p>
            )}
            {messages.map((m: any) => (
              <div key={m.id} className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}>
                {m.role !== "user" && (
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                    <Bot className="h-4 w-4" />
                  </div>
                )}
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  {m.content}
                </div>
                {m.role === "user" && (
                  <div className="h-8 w-8 rounded-full bg-accent flex items-center justify-center shrink-0">
                    <User className="h-4 w-4" />
                  </div>
                )}
              </div>
            ))}
            {sendMut.isPending && (
              <div className="flex gap-3">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground">
                  Thinking…
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <form
              onSubmit={(e) => { e.preventDefault(); handleSend(); }}
              className="flex gap-2"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about your positions, P&L, signals…"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                disabled={sendMut.isPending}
              />
              <button
                type="submit"
                disabled={sendMut.isPending || !input.trim()}
                className="rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
              >
                <Send className="h-4 w-4" /> Send
              </button>
            </form>
            <p className="text-[10px] text-muted-foreground mt-2">
              NeurlX Assistant is informational and not financial advice. Verify all figures before trading.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
