import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "../components/Alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { AutoGrid } from "../components/ui/auto-grid";
import { StaleNotice } from "../components/shell/StaleNotice";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { StateBlock } from "../components/ui/state-block";
import { TextLink } from "../components/ui/text-link";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { CalendarDots, Plus } from "../components/ui/icons";
import { CardListSkeleton } from "../components/monitoring/parts";
import { ScheduleEditor } from "../components/schedules/ScheduleEditor";
import { adminEndpoints, type ScheduleRow } from "../lib/adminApi";
import {
  LIST_EMPTY_ENDED_POINTER, LIST_EMPTY_HINT, LIST_EMPTY_TITLE, LIST_FAILED_CAVEAT, nextOccurrenceLine, ruleSentence,
  scheduleCodes,
} from "../lib/scheduleCopy";

/**
 * Repeating bookings — GOAL item 14's list.
 *
 * <p>
 * <b>Why a page and not a tab of the grid.</b> D3 §5.1 puts this behind a Day | Plans
 * segmented control on `/schedule`, on the argument that an admin creating a league night is
 * already in the booking surface. Ruling 10 settled the navigation the other way — these are
 * destinations with their own URLs — and `App.tsx` and `lib/routeAnnouncer.ts` already carry
 * `/admin/schedules`. The argument is not lost: the grid links here, and this page's rows link
 * back to the dates they hold.
 * </p>
 *
 * <p>
 * <b>Three-state, and failed before empty.</b> The empty state of this page teaches the
 * feature — it is the sentence that explains what a repeating booking is for — which makes it
 * exactly the empty state that must never render over a read that failed. An admin who is
 * told "no repeating bookings yet" on the evening the API is down will create a second league
 * night on top of the one that already exists.
 * </p>
 */

const STATUSES = [
  { value: "active", label: "Running now" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All of them" },
] as const;

type Status = typeof STATUSES[number]["value"];

/** One row: the sentence, what it holds next, and the way into it. */
function ScheduleListRow({ row, timezone }: { row: ScheduleRow; timezone?: string }) {
  const sentence = ruleSentence({
    courtNames: (row.courts ?? []).map((c) => c.name),
    days: row.days ?? [],
    start: row.start ?? "",
    end: row.end ?? "",
    label: row.label,
    startDate: row.start_date ?? "",
    endDate: row.end_date,
    intervalWeeks: row.interval_weeks,
  });
  return (
    <li className="flex">
      {/* A card (R4 form factor, SPEC §3.14): the rows sat in one 1,500px list at 1920. */}
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs sm:p-5">
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">{row.name}</h2>
            {/* A word, not a colour: "Ended" is the state, and the badge carries the word. */}
            {row.status === "ended" && <Badge tone="neutral">Ended</Badge>}
          </div>
          <p className="text-sm text-text-secondary">{sentence}</p>
          <p className="text-sm text-text-muted">{nextOccurrenceLine(row.next_occurrence, row.status, timezone)}</p>
        </div>
        {/* Named by the thing it opens, because a column of links all reading "Open" says
            nothing to anybody tabbing down it. */}
        {/* R10: it navigates, so it is a link that looks like one — it was a bordered box
            posing as a button. */}
        <TextLink variant="standalone" to={`/admin/schedules/${row.id}`} className="self-start text-sm">
          {`Open ${row.name}`}
        </TextLink>
      </div>
    </li>
  );
}

type ScheduleRead = {
  key: string; status: Status; rows: ScheduleRow[] | null; error: unknown; timezone?: string;
  /** When `rows` were read — kept across a failed re-read of the same list. */
  at: number | null;
};

/**
 * A re-read of the SAME list that failed (after a create, say) keeps the rows it had, under
 * "Couldn't refresh" (R4); another list's rows are not this list's answer, so a failure there
 * has nothing to keep.
 */
function keptOnFailure(prev: ScheduleRead, key: string, status: Status, error: unknown): ScheduleRead {
  const same = prev.status === status && prev.rows !== null;
  return { key, status, rows: same ? prev.rows : null, error, timezone: same ? prev.timezone : undefined, at: same ? prev.at : null };
}

export function AdminSchedulesPage() {
  const [status, setStatus] = useState<Status>("active");
  const [nonce, setNonce] = useState(0);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ScheduleRow | null>(null);

  /**
   * One state object carrying the KEY of the read it came from.
   *
   * The obvious shape — three states, reset at the top of the effect — calls setState
   * synchronously in an effect body, which is a cascading render the compiler cannot memoize
   * around and which this repo's lint gate rejects. Keyed, the effect only starts a request
   * and the loading arm is "what I am holding is not what I asked for", which is also the
   * more honest sentence: rows from the previous filter are not this filter's answer.
   */
  const key = `${status}:${nonce}`;
  const [read, setRead] = useState<ScheduleRead>({ key: "", status, rows: null, error: null, at: null });
  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const asked = `${status}:${nonce}`;
    adminEndpoints.schedules(status)
      .then((page) => { if (live) setRead({ key: asked, status, rows: page.schedules ?? [], error: null, timezone: page.timezone, at: Date.now() }); })
      .catch((err) => { if (live) setRead((prev) => keptOnFailure(prev, asked, status, err)); });
    return () => { live = false; };
  }, [status, nonce]);

  const loading = read.key !== key;
  const rows = loading ? null : read.rows;
  // Rows kept from the last good read of this list stand under "Couldn't refresh" (R4).
  const kept = !loading && read.error !== null && rows !== null;
  const error = loading || kept ? null : read.error;

  const codes = useMemo(() => scheduleCodes({}), []);

  const header = (
    <PageHeader
      title="Repeating bookings"
      actions={creating ? null : (
        // Wraps rather than widening the page at 200% text (R3 X-4).
        <Button className="!h-auto min-h-touch whitespace-normal py-2" onClick={() => setCreating(true)} icon={<Plus aria-hidden="true" />}>
          Create a repeating booking
        </Button>
      )}
      description={"A repeating booking holds the same courts at the same time, week after week — "
        + "league nights, coaching, court maintenance. Members see its name on the grid and "
        + "cannot book those slots."}
    />
  );

  if (creating) {
    return (
      <PageShell width="full">
        {header}
        {/* A form reads in a column, not across 1,500px (R4 form factor): the editor keeps the
            80rem it was drawn for, its conflicts panel included. */}
        <div className="w-full max-w-wide">
          <ScheduleEditor
            onCancel={() => { setCreating(false); }}
            onCreated={(row) => { setCreating(false); setCreated(row); load(); }}
          />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell width="full">
      {header}

      {created && (
        <Alert tone="success" live="polite" announceKey={`schedule-created-${created.id}`}>
          {`“${created.name}” was created. `}
          <TextLink to={`/admin/schedules/${created.id}`}>
            {`Open ${created.name} to see its dates`}
          </TextLink>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/* Three choices, always visible: a segmented control, not a select that hides two. */}
          <ToggleGroup
            type="single"
            aria-label="Which ones"
            value={status}
            onValueChange={(next) => { if (next) setStatus(next as Status); }}
            className="rounded-lg bg-bg-muted p-1"
          >
            {STATUSES.map((s) => (
              <ToggleGroupItem key={s.value} value={s.value}>{s.label}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <StaleNotice stale={kept} readAt={read.at} />
        <StateBlock
          loading={loading}
          error={error}
          action="read the club's repeating bookings"
          codes={codes}
          failedCaveat={LIST_FAILED_CAVEAT}
          onRetry={load}
          empty={rows !== null && rows.length === 0}
          emptyIcon={CalendarDots}
          emptyTitle={status === "active" ? LIST_EMPTY_TITLE : "None in that list."}
          emptyHint={status === "active" ? `${LIST_EMPTY_HINT} ${LIST_EMPTY_ENDED_POINTER}` : "Try “All of them”."}
          // The way out of an empty list is on it (R4 form factor): it was one centred line on a
          // 1,200px canvas with the button far away in the header.
          emptyAction={status === "active" ? (
            <Button variant="outline" className="!h-auto min-h-touch whitespace-normal py-2" onClick={() => setCreating(true)} icon={<Plus aria-hidden="true" />}>
              Create the first one
            </Button>
          ) : null}
          skeleton={<CardListSkeleton rows={3} />}
        >
          <AutoGrid as="ul" min="panel" max={3} gap="lg">
            {(rows ?? []).map((row) => <ScheduleListRow key={row.id} row={row} timezone={read.timezone} />)}
          </AutoGrid>
        </StateBlock>
      </div>
    </PageShell>
  );
}
