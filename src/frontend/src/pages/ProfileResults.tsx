import { useCallback, useEffect, useState } from "react";
import { AutoGrid } from "@/components/ui/auto-grid";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trophy } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { TextLink } from "@/components/ui/text-link";
import { Alert } from "@/components/Alert";
import { RecentToRecord } from "@/components/play/RecentToRecord";
import { ResultScore } from "@/components/play/ResultScore";
import { outcomeLine, STATUS_TONE } from "@/components/play/resultFacts";
import { useAuth } from "@/lib/useAuth";
import { playEndpoints, type MyResultRow } from "@/lib/playApi";
import { PLAY_REFUSAL, playRefusal, playWhen, RESULTS_PAGE, STATUS_WORD } from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { usePagedFocus } from "@/lib/usePagedFocus";

/**
 * `/profile/results` — every match the member is in, newest first (§6.2, §9.5): confirmed,
 * waiting and disputed (a voided or withdrawn result is nobody's record). Paged by the server's
 * cursor; "Show more" appends. Each row opens its booking, where the result can be acted on.
 */
type Held = { rows: MyResultRow[] | null; next: string | null; error: unknown; loading: boolean; at: number | null };

function useResults() {
  const [held, setHeld] = useState<Held>({ rows: null, next: null, error: null, loading: true, at: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    playEndpoints.myResults(null).then(
      (page) => { if (live) setHeld({ rows: page.items, next: page.next_cursor, error: null, loading: false, at: Date.now() }); },
      (error: unknown) => { if (live) setHeld((prev) => ({ ...prev, error, loading: false })); },
    );
    return () => { live = false; };
  }, [nonce]);
  const reload = useCallback(() => {
    setHeld((prev) => ({ ...prev, loading: true }));
    setNonce((n) => n + 1);
  }, []);
  const more = useAsyncAction(async () => {
    const page = await playEndpoints.myResults(held.next);
    setHeld((prev) => ({ ...prev, rows: [...(prev.rows ?? []), ...page.items], next: page.next_cursor }));
  });
  return { held, reload, more };
}

export default function ProfileResultsPage() {
  const { held, reload, more } = useResults();
  const rows = held.rows;
  // R13 X13-1: the last page takes "Show more" away, so the first result it brought takes focus.
  const showMore = usePagedFocus("[data-results] [data-result-link]", more.run);
  return (
    // R6 F5 (R4 SPEC 3.7): `wide`, the results in columns — a 36rem column was 40 % of a 1280
    // screen and 25 % of a 1920 one. `narrow` is for single-task forms only.
    <PageShell width="wide">
      <PageHeader
        back={{ to: "/profile#my-game", label: RESULTS_PAGE.back }}
        title={RESULTS_PAGE.title}
        description={RESULTS_PAGE.description}
        actions={<RefreshButton onRefresh={reload} loading={held.loading} label={RESULTS_PAGE.refresh} />}
        freshness={<Freshness at={held.at} />}
      />
      <RecentToRecord />
      <StateBlock
        loading={rows === null && held.loading}
        error={rows === null ? held.error : null}
        action={RESULTS_PAGE.readAction}
        codes={PLAY_REFUSAL}
        onRetry={reload}
        empty={rows !== null && rows.length === 0}
        emptyIcon={Trophy}
        emptyTitle={RESULTS_PAGE.emptyTitle}
        emptyHint={RESULTS_PAGE.emptyHint}
        skeleton={<div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>}
      >
        <AutoGrid as="ol" data-results="" min="panel" max={3} gap="md" className="items-start">
          {(rows ?? []).map((row) => <ResultRowItem key={row.result_id} row={row} />)}
        </AutoGrid>
        {more.error ? <Alert tone="danger" live="assertive">{playRefusal(more.error, RESULTS_PAGE.moreAction)}</Alert> : null}
        {held.next ? (
          <div><Button variant="outline" pending={more.pending} onClick={showMore}>{RESULTS_PAGE.more}</Button></div>
        ) : null}
      </StateBlock>
    </PageShell>
  );
}

function ResultRowItem({ row }: { row: MyResultRow }) {
  const auth = useAuth();
  const you = auth.status === "authenticated" ? auth.userId : null;
  const outcome = row.status === "confirmed" ? outcomeLine(row) : null;
  return (
    <li data-result-row={row.status} className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TextLink to={`/bookings/${encodeURIComponent(row.booking_id)}`} variant="standalone" data-result-link="">
          {RESULTS_PAGE.row(row.court_name, playWhen(row.starts_at))}
        </TextLink>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_WORD[row.status]}</Badge>
      </div>
      <ResultScore result={row} you={you} />
      {outcome ? <p className="text-sm font-semibold text-text-primary">{outcome}</p> : null}
    </li>
  );
}
