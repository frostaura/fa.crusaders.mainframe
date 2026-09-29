import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import { ResultRow } from "@/components/play/admin/ResultRow";
import { Button } from "@/components/ui/button";
import { Trophy } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { refreshAttentionCounts } from "@/lib/adminAttention";
import { playEndpoints, type AdminResult } from "@/lib/playApi";
import { ADMIN_RESULTS, PLAY_REFUSAL, playRefusal } from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";

/**
 * `/admin/results` — Match results (§9.4): the disputes waiting for the club (the default tab,
 * oldest first), and the other states to look back through. Two decisions, each with a reason on
 * the change record: remove a wrong result, or keep a disputed one.
 *
 * <p>
 * A decided row leaves its tab at once and the rail's disputes badge re-reads, so the number an
 * admin just brought down is the number the console shows.
 * </p>
 */
const TABS = ["disputed", "pending", "confirmed", "voided"] as const;
type Tab = (typeof TABS)[number];

type Held = { tab: Tab; rows: AdminResult[] | null; next: string | null; error: unknown; at: number | null; key: string };

function useResultsTab(tab: Tab) {
  const [nonce, setNonce] = useState(0);
  const asked = `${tab}:${nonce}`;
  const [held, setHeld] = useState<Held>({ tab, rows: null, next: null, error: null, at: null, key: "" });
  useEffect(() => {
    let live = true;
    playEndpoints.adminResults(tab).then(
      (page) => { if (live) setHeld({ tab, rows: page.items, next: page.next_cursor, error: null, at: Date.now(), key: asked }); },
      (error: unknown) => {
        if (live) setHeld((prev) => ({ ...prev, tab, rows: prev.tab === tab ? prev.rows : null, error, key: asked }));
      },
    );
    return () => { live = false; };
  }, [tab, asked]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const more = useAsyncAction(async () => {
    const page = await playEndpoints.adminResults(tab, held.next);
    setHeld((prev) => ({ ...prev, rows: [...(prev.rows ?? []), ...page.items], next: page.next_cursor }));
  });
  const drop = useCallback((id: string) => {
    setHeld((prev) => ({ ...prev, rows: prev.rows?.filter((r) => r.result_id !== id) ?? null }));
  }, []);
  const same = held.tab === tab;
  return {
    rows: same ? held.rows : null,
    next: same ? held.next : null,
    error: held.key === asked ? held.error : null,
    loading: held.key !== asked,
    at: same ? held.at : null,
    reload,
    more,
    drop,
  };
}

export default function AdminResultsPage() {
  const [tab, setTab] = useState<Tab>("disputed");
  const read = useResultsTab(tab);
  const [notice, setNotice] = useState<string | null>(null);
  const decided = (row: AdminResult, text: string) => {
    read.drop(row.result_id);
    setNotice(text);
    void refreshAttentionCounts();
  };
  return (
    <PageShell width="wide">
      <PageHeader
        title={ADMIN_RESULTS.title}
        description={ADMIN_RESULTS.description}
        actions={<RefreshButton onRefresh={read.reload} loading={read.loading} label={ADMIN_RESULTS.refresh} />}
        freshness={<Freshness at={read.at} />}
      />
      <p aria-live="polite" className="sr-only">{notice ?? ""}</p>
      {notice ? <Alert tone="success" live="off">{notice}</Alert> : null}
      <Tabs variant="underline" activationMode="manual" value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          {TABS.map((t) => <TabsTrigger key={t} value={t}>{ADMIN_RESULTS.tabs[t]}</TabsTrigger>)}
        </TabsList>
        {TABS.map((t) => (
          <TabsContent key={t} value={t} className="pt-4">
            {t === tab ? <TabBody tab={t} read={read} onDecided={decided} /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </PageShell>
  );
}

type TabBodyProps = { tab: Tab; read: ReturnType<typeof useResultsTab>; onDecided: (row: AdminResult, text: string) => void };

function TabBody({ tab, read, onDecided }: TabBodyProps) {
  const rows = read.rows;
  return (
    <StateBlock
      loading={rows === null && read.loading}
      error={rows === null ? read.error : null}
      action={ADMIN_RESULTS.readAction}
      codes={PLAY_REFUSAL}
      onRetry={read.reload}
      empty={rows !== null && rows.length === 0}
      emptyIcon={Trophy}
      emptyTitle={ADMIN_RESULTS.emptyTitle[tab]}
      emptyHint={ADMIN_RESULTS.emptyHint[tab]}
      skeleton={<div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-xl" />)}</div>}
    >
      <ul data-admin-results={tab} className="flex flex-col gap-3">
        {(rows ?? []).map((row) => <ResultRow key={row.result_id} row={row} onDecided={onDecided} />)}
      </ul>
      {read.more.error ? <Alert tone="danger" live="assertive">{playRefusal(read.more.error, ADMIN_RESULTS.readAction)}</Alert> : null}
      {read.next ? (
        <div><Button variant="outline" pending={read.more.pending} onClick={() => void read.more.run()}>{ADMIN_RESULTS.more}</Button></div>
      ) : null}
    </StateBlock>
  );
}
