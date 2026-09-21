import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../components/Alert";
import { Label, Select } from "../../components/Button";
import { Card } from "../../components/Card";
import { MonitoringNav } from "../../components/monitoring/MonitoringNav";
import { StateBlock } from "../../components/StateBlock";
import { clubDayAndClock } from "../../lib/clubClock";
import {
  ADMIN_CHANGE_AREAS, adminEndpoints, type AdminChangePage, type AdminChangeRow,
} from "../../lib/adminApi";
import {
  CHANGES_EMPTY, CHANGES_EXPORT_NOTE, CHANGES_NO_DIFF, CHANGES_STANDING_NOTICE,
} from "../../lib/nightCopy";

/**
 * The admin change record — GOAL item 14's second half. `/admin/monitoring/changes`.
 *
 * <p>
 * <b>"admin-wide admin record of these admin changes so even they can monitor themselves.
 * These records become non-deletable even by admins."</b> That is the requirement verbatim,
 * and the hard half of it is the second sentence.
 * </p>
 *
 * <p>
 * <b>Why this reads a separate table rather than the audit log.</b> `audit_log` has a delete
 * path — the retention worker removes door rows on a cutoff an admin controls through a
 * setting — so a record that "no role can delete" cannot live in it, and the two requirements
 * conflict at the database: making it undeletable means revoking DELETE, and the retention
 * sweep needs DELETE. Hence `admin_change_log`, append-only, trigger-protected, exempt from
 * retention.
 * </p>
 *
 * <p>
 * <b>And the claim on the page is narrower than "tamper-proof", on purpose.</b> See
 * {@link CHANGES_STANDING_NOTICE}: the software guarantees there is no delete anywhere in it
 * and that the database refuses one, which is true. It does not claim that somebody with the
 * database owner's password cannot disable a trigger, because they can, and an audit trail
 * that oversells itself is worse than none — the club would rely on it.
 * </p>
 *
 * <p>
 * <b>There is no delete control and no edit control on this page, and a test asserts it of
 * the whole DOM.</b> That is the one property this surface must be able to prove.
 * </p>
 */

/** What an area is CALLED. An admin does not read "setting"; they read "Club settings". */
const AREA_LABEL: Record<string, string> = {
  schedule: "Repeating bookings",
  booking: "Bookings",
  credit: "Money",
  group: "Member groups",
  member: "Members",
  setting: "Club settings",
  device: "Boards and doors",
};

export function AdminChangeRecordPage() {
  const [page, setPage] = useState<AdminChangePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [area, setArea] = useState("");
  const [period, setPeriod] = useState("last_7d");

  const load = useCallback(async (which: string, when: string) => {
    setLoading(true);
    try {
      setPage(await adminEndpoints.adminChanges({
        ...(which ? { area: which } : {}),
        period: when,
      }));
      setError(null);
    } catch (err) {
      // Cleared, unlike the control board: a filtered list that keeps the PREVIOUS filter's
      // rows under the new filter's heading is a screen that answers a question nobody asked.
      setPage(null);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // `load` is async; the only synchronous thing here is starting a request, and every
  // setState inside it runs in a promise callback. Re-reading when a filter changes is what
  // this effect is FOR.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void load(area, period); }, [load, area, period]);

  const rows = page?.rows ?? [];
  const timezone = page?.timezone;

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Admin change record</h1>
        <MonitoringNav />
      </header>

      <Alert tone="info" live="standing" announceKey="changes-immutability">
        {CHANGES_STANDING_NOTICE}
      </Alert>

      {/*
        The retention sentence comes from the SERVER, never composed here from a number.
        The two horizons on this estate are different — audit rows age out, these do not —
        and a page that hardcoded one of them would be wrong the day a club edits the other.
      */}
      {page?.retention && <p className="text-sm text-text-muted">{`How long these are kept: ${page.retention}`}</p>}

      <Card className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="changes-area">What</Label>
          <Select
            id="changes-area"
            className="min-h-11"
            value={area}
            onChange={(e) => setArea(e.target.value)}
          >
            <option value="">Everything</option>
            {ADMIN_CHANGE_AREAS.map((a) => (
              <option key={a} value={a}>{AREA_LABEL[a] ?? a}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="changes-period">When</Label>
          <Select
            id="changes-period"
            className="min-h-11"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last_7d">Last 7 days</option>
            <option value="last_30d">Last 30 days</option>
          </Select>
        </div>
        <a
          className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-control bg-bg-surface px-4 text-sm font-medium"
          href={adminEndpoints.adminChangesCsvUrl({ ...(area ? { area } : {}), period })}
        >
          Download CSV
        </a>
        <p className="w-full text-xs text-text-muted">{CHANGES_EXPORT_NOTE}</p>
      </Card>

      <StateBlock
        loading={loading}
        error={error}
        action="the change record"
        failedCaveat="That does not mean nothing happened."
        onRetry={() => void load(area, period)}
        empty={!loading && !error && rows.length === 0}
        emptyTitle={CHANGES_EMPTY}
        emptyHint="Every admin action lands here the moment it happens, so an empty range means nobody did anything in it."
      >
        <ul className="space-y-3">
          {rows.map((row) => <ChangeRow key={row.id} row={row} timezone={timezone} />)}
        </ul>
      </StateBlock>
    </div>
  );
}

/**
 * One change — a card at 375, and the same card at 1440 because it reads perfectly well.
 *
 * <p>
 * The `changes[]` diff arrives already RENDERED from the server — "18:00", not 1080; a court's
 * name, not its id — so this component displays it and does not interpret it. A volunteer
 * reading their own audit trail cannot be handed minutes past midnight, and the place to turn
 * 1080 into "18:00" is the place that knows the club's clock, which is not the browser.
 * </p>
 */
function ChangeRow({ row, timezone }: { row: AdminChangeRow; timezone: string | undefined }) {
  const diff = row.changes ?? [];
  return (
    <li className="rounded-lg border border-border bg-bg-surface p-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <time dateTime={row.occurred_at} className="shrink-0 text-sm tabular-nums text-text-muted">
          {clubDayAndClock(row.occurred_at, timezone)}
        </time>
        <p className="min-w-0 break-words font-medium text-text-primary">
          {/* Server-composed, from a closed dictionary, with `unrecognised` for anything the
              dictionary has not got. Never a sentence assembled here out of `action`. */}
          {row.headline ?? (row.action ?? "").replace(/[._]/g, " ")}
        </p>
        {row.actor?.name && <span className="shrink-0 text-sm text-text-muted">{row.actor.name}</span>}
      </div>
      {row.subject?.label && <p className="text-sm text-text-secondary">{row.subject.label}</p>}
      {row.reason && <p className="text-sm text-text-secondary">{`Reason: “${row.reason}”`}</p>}

      {diff.length > 0 ? (
        <details className="mt-2">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium">
            Show what changed
          </summary>
          <dl className="mt-1 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-muted">Field</dt>
            <dd className="text-text-muted">Before</dd>
            <dd className="text-text-muted">After</dd>
            {diff.map((change) => (
              <div key={change.field} className="contents">
                <dt className="min-w-0 break-words text-text-secondary">{change.field.replace(/_/g, " ")}</dt>
                {/* An em dash, not an empty cell: a blank reads as "the page did not load it"
                    and a dash reads as "there was nothing there", which is the true one. */}
                <dd className="min-w-0 break-words text-text-primary">{change.before ?? "—"}</dd>
                <dd className="min-w-0 break-words text-text-primary">{change.after ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : (
        <p className="mt-1 text-sm text-text-muted">{CHANGES_NO_DIFF}</p>
      )}
    </li>
  );
}
