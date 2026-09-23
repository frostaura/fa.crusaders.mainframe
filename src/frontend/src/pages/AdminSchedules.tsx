import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "../components/Alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { StateBlock } from "../components/ui/state-block";
import { TextLink } from "../components/ui/text-link";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { CalendarDots, Plus } from "../components/ui/icons";
import { CardListSkeleton } from "../components/monitoring/parts";
import { ScheduleEditor } from "../components/schedules/ScheduleEditor";
import { adminEndpoints, type ScheduleRow } from "../lib/adminApi";
import {
  LIST_EMPTY_HINT, LIST_EMPTY_TITLE, LIST_FAILED_CAVEAT, nextOccurrenceLine, ruleSentence,
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
function ScheduleListRow({ row }: { row: ScheduleRow }) {
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
    <li>
      <div className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">{row.name}</h2>
            {/* A word, not a colour: "Ended" is the state, and the badge carries the word. */}
            {row.status === "ended" && <Badge tone="neutral">Ended</Badge>}
          </div>
          <p className="text-sm text-text-secondary">{sentence}</p>
          <p className="text-sm text-text-muted">{nextOccurrenceLine(row.next_occurrence, row.status)}</p>
        </div>
        {/* Named by the thing it opens, because a column of links all reading "Open" says
            nothing to anybody tabbing down it. */}
        {/* R10: it navigates, so it is a link that looks like one — it was a bordered box
            posing as a button. */}
        <TextLink variant="standalone" to={`/admin/schedules/${row.id}`} className="shrink-0 text-sm">
          {`Open ${row.name}`}
        </TextLink>
      </div>
    </li>
  );
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
  const [read, setRead] = useState<{ key: string; rows: ScheduleRow[] | null; error: unknown }>(
    { key: "", rows: null, error: null },
  );
  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    const asked = `${status}:${nonce}`;
    adminEndpoints.schedules(status)
      .then((page) => { if (live) setRead({ key: asked, rows: page.schedules ?? [], error: null }); })
      .catch((err) => { if (live) setRead({ key: asked, rows: null, error: err }); });
    return () => { live = false; };
  }, [status, nonce]);

  const loading = read.key !== key;
  const rows = loading ? null : read.rows;
  const error = loading ? null : read.error;

  const codes = useMemo(() => scheduleCodes({}), []);

  const header = (
    <PageHeader
      title="Repeating bookings"
      actions={creating ? null : (
        <Button onClick={() => setCreating(true)} icon={<Plus aria-hidden="true" />}>
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
      <PageShell width="wide">
        {header}
        <ScheduleEditor
          onCancel={() => { setCreating(false); }}
          onCreated={(row) => { setCreating(false); setCreated(row); load(); }}
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="wide">
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

        <StateBlock
          loading={loading}
          error={error}
          action="the club's repeating bookings"
          codes={codes}
          failedCaveat={LIST_FAILED_CAVEAT}
          onRetry={load}
          empty={rows !== null && rows.length === 0}
          emptyIcon={CalendarDots}
          emptyTitle={status === "active" ? LIST_EMPTY_TITLE : "None in that list."}
          emptyHint={status === "active" ? LIST_EMPTY_HINT : "Try “All of them”."}
          skeleton={<CardListSkeleton rows={3} />}
        >
          <ul className="divide-y divide-border rounded-xl border border-border bg-bg-surface shadow-xs">
            {(rows ?? []).map((row) => <ScheduleListRow key={row.id} row={row} />)}
          </ul>
        </StateBlock>
      </div>
    </PageShell>
  );
}
