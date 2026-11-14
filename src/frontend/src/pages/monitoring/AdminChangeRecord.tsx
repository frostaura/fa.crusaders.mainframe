import { useCallback, useEffect, useState } from "react";
import { Alert } from "../../components/Alert";
import { cn } from "../../lib/utils";
import { Button } from "../../components/ui/button";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { Freshness, RefreshButton } from "../../components/ui/refresh-button";
import { StateBlock } from "../../components/ui/state-block";
import { CaretDown, ListChecks } from "../../components/ui/icons";
import {
  CardListSkeleton, DownloadCsvButton, FilterBar, FilterSelect, type FilterOption,
} from "../../components/monitoring/parts";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { usePagedFocus } from "../../lib/usePagedFocus";
import { clubDayAndClock } from "../../lib/clubClock";
import {
  ADMIN_CHANGE_AREAS, adminEndpoints, type AdminChangePage, type AdminChangeRow,
} from "../../lib/adminApi";
import {
  CHANGES_EMPTY, CHANGES_EXPORT_NOTE, CHANGES_NO_DIFF, CHANGES_STANDING_NOTICE,
} from "../../lib/nightCopy";
import { CHANGES_PAGE, changeHeadline, hasChangeDiff } from "../../lib/changeRecordCopy";
import { ChangeDiff } from "../../components/admin/ChangeDiff";
import { describeFailure } from "../../lib/errors";

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

  // F3.2 (contract §8): the server pages by cursor; the page used to show the first page and
  // stop, with nothing saying there was more. "Load more" APPENDS — the rows already read keep
  // their place — and a failed page leaves them standing with its own sentence.
  const [moreError, setMoreError] = useState<unknown>(null);
  const more = useAsyncAction(async () => {
    const cursor = page?.cursor;
    if (!cursor) return;
    try {
      const next = await adminEndpoints.adminChanges({ ...(area ? { area } : {}), period, cursor });
      setPage((prev) => ({ ...next, rows: [...(prev?.rows ?? []), ...next.rows] }));
      setMoreError(null);
    } catch (err) {
      setMoreError(err);
    }
  });
  // R9 X9-2 / R12 X12-2: the last page takes "Load more" away and focus fell to <body>; the reader
  // carries on from the first row this page brought — the one paged-list rule (usePagedFocus).
  const loadMore = usePagedFocus("[data-change-row]", more.run);

  return (
    <PageShell width="full">
      <PageHeader
        title="Change record"
        // The retention sentence (the server's) sits under the list now: beside the banner it
        // said "cannot be deleted" twice in a row (F3-14).
        description="Every admin action, in the order it happened."
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
          <DownloadCsvButton
            className="sm:ml-auto" fallbackName="change-record.csv"
            path={adminEndpoints.adminChangesCsvUrl({ ...(area ? { area } : {}), period })}
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
        <ul className="@container/changes flex flex-col gap-3">
          {rows.map((row) => <ChangeRow key={row.id} row={row} timezone={timezone} />)}
        </ul>
        <div className="mt-3 flex flex-col items-start gap-2">
          {page?.retention ? (
            // From the SERVER, never composed here from a number: audit rows age out and these do
            // not, and a page that hardcoded one horizon would be wrong the day a club edits it.
            <p className="text-sm text-text-muted">{`How long these are kept: ${page.retention}`}</p>
          ) : null}
          {typeof page?.total === "number" ? (
            <p className="text-sm text-text-muted" aria-live="polite">{CHANGES_PAGE.showing(rows.length, page.total)}</p>
          ) : null}
          {moreError !== null ? (
            <Alert tone="danger" live="polite" announceKey="changes-more">
              {describeFailure(moreError, { action: CHANGES_PAGE.loadMoreAction })}
            </Alert>
          ) : null}
          {page?.cursor ? (
            <Button variant="outline" onClick={loadMore} pending={more.pending}>{CHANGES_PAGE.loadMore}</Button>
          ) : null}
        </div>
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
/** A name on a change row: whole words where the row can hold them (R14 L14-3, see the row's inset). */
const CHANGE_NAME = "min-w-0 break-words text-xs @[12rem]/changes:text-sm";

/** The row: a stacked card in a narrow list, one dense wrapping line from 48rem (BA-25). */
export const CHANGE_ROW = cn(
  "flex flex-col gap-1 rounded-xl border border-border bg-bg-surface p-2 shadow-xs @[12rem]/changes:p-4",
  "@[48rem]/changes:flex-row @[48rem]/changes:flex-wrap @[48rem]/changes:items-baseline @[48rem]/changes:gap-x-4",
  "@[48rem]/changes:rounded-lg @[48rem]/changes:py-2 @[48rem]/changes:shadow-none",
);

function ChangeRow({ row, timezone }: { row: AdminChangeRow; timezone: string | undefined }) {
  return (
    // tabIndex -1: focusable by script only, so "Load more" can hand focus to the first row it brought.
    // R10 L10-6: the card's inset and the headline step down by the LIST's box in rem — at 320 /
    // 200 % text "administrator" was wider than the card's text column and broke "administrato/r".
    // R14 L14-3 — and under 12rem the inset is p-2 and the names (who did it, who it was done to)
    // text-xs: at 320 / 200 % a 17-letter surname was 244px in a 206px column and broke mid-word;
    // it is 209px of 222 now. Chromium's `hyphens: auto` never splits a Capitalised word.
    // BA-25: from a 48rem list the row is ONE dense line — when, what, who, and the diff toggle at its
    // end — at 8px block padding, instead of a 130px card for a single line; an opened diff takes the
    // row's full width beneath it. Narrower lists keep the stacked card the rules above describe.
    <li data-change-row="" tabIndex={-1} className={CHANGE_ROW}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-2 @[48rem]/changes:flex-1">
        <time dateTime={row.occurred_at} className="shrink-0 text-sm tabular-nums text-text-muted">
          {clubDayAndClock(row.occurred_at, timezone)}
        </time>
        <p className="min-w-0 break-words text-sm font-medium text-text-primary @[12rem]/changes:text-base">
          {/* Server-composed, from a closed dictionary, with `unrecognised` for anything the
              dictionary has not got. Never a sentence assembled here out of `action`. */}
          {changeHeadline(row)}
        </p>
        {/* Wraps, never shrink-0 (R4 V4-6): a long name made the record scroll sideways at 320. */}
        {row.actor?.name && <span className={cn(CHANGE_NAME, "text-text-muted")}>{row.actor.name}</span>}
      </div>
      {row.subject?.label && <p className={cn(CHANGE_NAME, "text-text-secondary")}>{row.subject.label}</p>}
      {row.reason && <p className="text-sm text-text-secondary">{`Reason: “${row.reason}”`}</p>}

      {hasChangeDiff(row) ? (
        <details className="group mt-1 @[48rem]/changes:mt-0 @[48rem]/changes:open:basis-full">
          <summary className="no-lift inline-flex min-h-touch cursor-pointer list-none items-center gap-1 text-sm font-semibold text-accent-strong @[48rem]/changes:min-h-0 [&::-webkit-details-marker]:hidden">
            Show what changed
            {/* R8 L6-16: 1rem, so it grows with "Show what changed" (it stayed 16px at 200 %). */}
            <CaretDown size="1rem" aria-hidden="true" className="shrink-0 transition-transform duration-fast group-open:rotate-180 motion-reduce:transition-none" />
          </summary>
          <ChangeDiff row={row} />
        </details>
      ) : (
        <p className="text-sm text-text-muted">{CHANGES_NO_DIFF}</p>
      )}
    </li>
  );
}
