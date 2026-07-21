import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { AppShell, PageHeader, Metric } from "@/components/AppShell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  ASSET_CLASSES, getMultiAssetOverview, toggleWatchlist,
} from "@/lib/multiAsset.functions";
import { useState, useMemo } from "react";
import { Star, StarOff, Search } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/multi-asset")({
  head: () => ({ meta: [{ title: "Multi-Asset Universe — NeurlX" }, { name: "robots", content: "noindex" }] }),
  component: MultiAssetPage,
});

function MultiAssetPage() {
  const overviewFn = useServerFn(getMultiAssetOverview);
  const toggleFn = useServerFn(toggleWatchlist);
  const qc = useQueryClient();
  const [q, setQ] = useState("");

  const { data, isLoading } = useQuery({ queryKey: ["multi-asset"], queryFn: () => overviewFn() });
  const toggleMut = useMutation({
    mutationFn: (v: { instrument_id: string; enabled: boolean }) => toggleFn({ data: v }),
    onSuccess: (_, v) => {
      toast.success(v.enabled ? "Added to watchlist" : "Removed");
      qc.invalidateQueries({ queryKey: ["multi-asset"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <AppShell><div className="text-muted-foreground">Loading universe…</div></AppShell>;

  return (
    <AppShell>
      <PageHeader
        title="Multi-Asset Universe"
        subtitle="Browse and watchlist instruments across crypto, equities, forex, commodities, and indices."
      />

      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Instruments" value={String(data.totalUniverse)} />
        <Metric label="Watchlisted" value={String(data.totalWatched)} />
        <Metric label="Asset Classes" value={String(ASSET_CLASSES.length)} />
        <Metric label="Connectors" value={String(new Set(Object.values(data.byClass).flat().map((i: any) => i.connector_id)).size)} />
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter symbol…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <Tabs defaultValue="all" className="mt-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="all">All ({data.totalUniverse})</TabsTrigger>
          {data.stats.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label} <span className="ml-1 text-xs text-muted-foreground">({s.total})</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="all">
          <InstrumentGrid
            items={Object.values(data.byClass).flat()}
            filter={q}
            onToggle={(id, enabled) => toggleMut.mutate({ instrument_id: id, enabled })}
          />
        </TabsContent>
        {ASSET_CLASSES.map((c) => (
          <TabsContent key={c.id} value={c.id}>
            <InstrumentGrid
              items={data.byClass[c.id] ?? []}
              filter={q}
              onToggle={(id, enabled) => toggleMut.mutate({ instrument_id: id, enabled })}
            />
          </TabsContent>
        ))}
      </Tabs>
    </AppShell>
  );
}

function InstrumentGrid({ items, filter, onToggle }: {
  items: any[]; filter: string; onToggle: (id: string, enabled: boolean) => void;
}) {
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.symbol.toLowerCase().includes(q) || i.base.toLowerCase().includes(q));
  }, [items, filter]);

  if (!filtered.length) return <div className="text-sm text-muted-foreground py-8 text-center">No instruments match.</div>;

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 mt-3">
      {filtered.map((i) => (
        <Card key={i.id} className="p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold font-mono">{i.symbol}</span>
              <Badge variant="outline" className="text-[10px] uppercase">{i.asset_class.replace("_", " ")}</Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {i.base}/{i.quote} · {i.exchange} · lev {Number(i.leverage_max)}x
            </div>
          </div>
          <Button
            size="icon"
            variant={i.watched ? "default" : "outline"}
            onClick={() => onToggle(i.id, !i.watched)}
            aria-label={i.watched ? "Remove from watchlist" : "Add to watchlist"}
          >
            {i.watched ? <Star className="h-4 w-4 fill-current" /> : <StarOff className="h-4 w-4" />}
          </Button>
        </Card>
      ))}
    </div>
  );
}
