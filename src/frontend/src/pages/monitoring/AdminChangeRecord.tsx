import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../components/Alert";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { Freshness, RefreshButton } from "../../components/ui/refresh-button";
import { StateBlock } from "../../components/ui/state-block";
import { CaretDown, ListChecks } from "../../components/ui/icons";
import {
  CardListSkeleton, DownloadCsvLink, FilterBar, FilterSelect, type FilterOption,
} from "../../components/monitoring/parts";
import { useAsyncAction } from "../../lib/useAsyncAction";
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
  group: "Groups",
  member: "Members",
  setting: "Club settings",
  device: "Boards and doors",
  play: "Match results",
};

export function AdminChangeRecordPage() {
  const [page, setPage] = useState<AdminChangePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [area, setArea] = useState("");
  const [period, setPeriod] = useState("last_7d");
  const [readAt, setReadAt] = useState<number | null>(null);

  const load = useCallback(async (which: string, when: string) => {
    setLoading(true);
    try {
      setPage(await adminEndpoints.adminChanges({
        ...(which ? { area: which } : {}),
        period: when,
      }));
      setError(null);
      setReadAt(Date.now());
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
  const manual = useAsyncAction(() => load(area, period));

  return (
    <PageShell width="wide">
      <PageHeader
        title="Change record"
        description={page?.retention
          // The retention sentence comes from the SERVER, never composed here from a number.
          // The two horizons on this estate are different — audit rows age out, these do not —
          // and a page that hardcoded one of them would be wrong the day a club edits the other.
          ? `Every admin action, in the order it happened. How long these are kept: ${page.retention}`
          : "Every admin action, in the order it happened."}
        actions={<RefreshButton onRefresh={() => void manual.run()} loading={manual.pending} />}
        freshness={<Freshness at={readAt} />}
      />

      <Alert tone="info" live="standing" announceKey="changes-immutability">
        {CHANGES_STANDING_NOTICE}
      </Alert>

      <div className="flex flex-col gap-2">
        <FilterBar>
          <FilterSelect
            id="changes-area"
            label="What"
            value={area}
            options={AREA_OPTIONS}
            onChange={setArea}
          />
          <FilterSelect
            id="changes-period"
            label="When"
            value={period}
            options={PERIOD_OPTIONS}
            onChange={setPeriod}
          />
          <DownloadCsvLink
            className="sm:ml-auto"
            href={adminEndpoints.adminChangesCsvUrl({ ...(area ? { area } : {}), period })}
          />
        </FilterBar>
        <p className="text-xs text-text-muted">{CHANGES_EXPORT_NOTE}</p>
      </div>

      <StateBlock
        loading={loading}
        error={error}
        action="read the change record"
        failedCaveat="That does not mean nothing happened."
        onRetry={() => void manual.run()}
        empty={!loading && !error && rows.length === 0}
        emptyIcon={ListChecks}
        emptyTitle={CHANGES_EMPTY}
        emptyHint="Every admin action lands here the moment it happens, so an empty range means nobody did anything in it."
        skeleton={<CardListSkeleton rows={4} />}
      >
        <ul className="flex flex-col gap-3">
          {rows.map((row) => <ChangeRow key={row.id} row={row} timezone={timezone} />)}
        </ul>
      </StateBlock>
    </PageShell>
  );
}

const AREA_OPTIONS: FilterOption[] = [
  { value: "", label: "Everything" },
  ...ADMIN_CHANGE_AREAS.map((a) => ({ value: a, label: AREA_LABEL[a] ?? a })),
];

const PERIOD_OPTIONS: FilterOption[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7d", label: "Last 7 days" },
  { value: "last_30d", label: "Last 30 days" },
];

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
    <li className="flex flex-col gap-1 rounded-xl border border-border bg-bg-surface p-4 shadow-xs">
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
        <details className="group mt-1">
          <summary className="no-lift inline-flex min-h-touch cursor-pointer list-none items-center gap-1 text-sm font-semibold text-accent-strong [&::-webkit-details-marker]:hidden">
            Show what changed
            <CaretDown size={16} aria-hidden="true" className="transition-transform duration-fast group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <dl className="mt-2 grid rounded-lg bg-bg-muted p-3 grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-sm">
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
        <p className="text-sm text-text-muted">{CHANGES_NO_DIFF}</p>
      )}
    </li>
  );
}
