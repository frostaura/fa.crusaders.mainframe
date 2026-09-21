import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "../components/Alert";
import { Badge, Button, Label, Select } from "../components/Button";
import { Card } from "../components/Card";
import { StateBlock } from "../components/StateBlock";
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
    <li className="border-b border-border last:border-b-0">
      <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-text-primary">{row.name}</h2>
            {/* A word, not a colour: "Ended" is the state, and the badge carries the word. */}
            {row.status === "ended" && <Badge tone="muted">Ended</Badge>}
          </div>
          <p className="text-sm text-text-secondary">{sentence}</p>
          <p className="text-sm text-text-muted">{nextOccurrenceLine(row.next_occurrence, row.status)}</p>
        </div>
        {/* Named by the thing it opens, because a column of links all reading "Open" says
            nothing to anybody tabbing down it. */}
        <Link
          to={`/admin/schedules/${row.id}`}
          // `border-control` is the token a CONTROL's boundary is measured at 3:1 with;
          // `border-border` is deliberately quieter and is for a card edge or a table rule.
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-control px-4 text-sm font-medium text-text-primary hover:bg-bg-muted"
        >
          {`Open ${row.name}`}
        </Link>
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

  if (creating) {
    return (
      <div className="space-y-6">
        <ScheduleEditor
          onCancel={() => { setCreating(false); }}
          onCreated={(row) => { setCreating(false); setCreated(row); load(); }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Repeating bookings</h1>
        <p className="text-sm text-text-secondary">
          {"A repeating booking holds the same courts at the same time, week after week — "}
          {"league nights, coaching, court maintenance. Members see its name on the grid and "}
          {"cannot book those slots."}
        </p>
      </div>

      {created && (
        <Alert tone="success" live="polite" announceKey={`schedule-created-${created.id}`}>
          {`“${created.name}” was created. `}
          <Link className="underline" to={`/admin/schedules/${created.id}`}>
            {`Open ${created.name} to see its dates`}
          </Link>
        </Alert>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="schedule-status">Which ones</Label>
          <Select
            id="schedule-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as Status)}
            className="min-h-11"
          >
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <Button className="min-h-11" onClick={() => setCreating(true)}>
          Create a repeating booking
        </Button>
      </div>

      <Card className="px-4">
        <StateBlock
          loading={loading}
          error={error}
          action="the club's repeating bookings"
          codes={codes}
          failedCaveat={LIST_FAILED_CAVEAT}
          onRetry={load}
          empty={rows !== null && rows.length === 0}
          emptyTitle={status === "active" ? LIST_EMPTY_TITLE : "None in that list."}
          emptyHint={status === "active" ? LIST_EMPTY_HINT : "Try “All of them”."}
        >
          <ul className="divide-y divide-border">
            {(rows ?? []).map((row) => <ScheduleListRow key={row.id} row={row} />)}
          </ul>
        </StateBlock>
      </Card>
    </div>
  );
}
