import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { CancelSheet, type CancelledOutcome } from "@/components/bookings/CancelSheet";
import type { GridBooking } from "@/components/bookings/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CalendarCheck } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { adminEndpoints, type UnsettledBooking, type UnsettledBookingsPage } from "@/lib/adminApi";
import { clubDayAndClock } from "@/lib/clubClock";
import { UNSETTLED_COPY as COPY } from "@/lib/unsettledCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { usePagedFocus } from "@/lib/usePagedFocus";
import { useRead } from "@/lib/useRead";
import { firstName } from "@/pages/admin/member/useMemberDetail";

/**
 * `/admin/bookings` — where the daily `booking.unsettled` notice sends an admin (BM-11, pass 2). Its
 * filter is "Never settled": the server's own list (`GET /admin/bookings/unsettled`), read by the
 * same query the notice counts, so the page cannot show 2 under a mail that said 3.
 *
 * <p>
 * Each row is decided with the desk's ordinary cancel (`CancelSheet`, admin): the same quote, the
 * same waiver with a reason, the same member mail. A cancelled row leaves the list at once and the
 * list is read again behind it.
 * </p>
 */
type Extra = { base: UnsettledBookingsPage | null; items: UnsettledBooking[]; cursor: string | null };

function useUnsettled() {
  const [readAt, setReadAt] = useState<number | null>(null);
  const load = useCallback(async () => {
    const page = await adminEndpoints.unsettledBookings();
    setReadAt(Date.now());
    return page;
  }, []);
  const [first, retry] = useRead("unsettled", load);
  const [extra, setExtra] = useState<Extra>({ base: null, items: [], cursor: null });
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const base = first.data;
  const follows = base !== null && extra.base === base;
  const cursor = follows ? extra.cursor : base?.next_cursor ?? null;
  const more = useAsyncAction(async () => {
    if (!base || !cursor) return;
    const page = await adminEndpoints.unsettledBookings(cursor);
    setExtra((prev) => ({ base, items: [...(prev.base === base ? prev.items : []), ...page.items], cursor: page.next_cursor }));
  });
  const items = [...(base?.items ?? []), ...(follows ? extra.items : [])].filter((r) => !gone.has(r.booking_id));
  return {
    page: base, readAt, items, cursor, loading: first.loading, error: first.error, retry, more,
    drop: (ids: string[]) => setGone((prev) => new Set([...prev, ...ids])),
  };
}

function toGridBooking(row: UnsettledBooking, timezone: string): GridBooking {
  const name = row.member?.name ?? COPY.unknownMember;
  return {
    bookingId: row.booking_id,
    courtId: row.court_id,
    courtName: row.court_name ?? COPY.unknownCourt,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    whenLabel: clubDayAndClock(row.starts_at, timezone),
    mine: false,
    memberFirstName: firstName(name),
    memberPhotoUrl: row.member?.photo_url ?? null,
    checkedIn: false,
    amountChargedMinutes: row.charged_minutes,
    timezone,
  };
}

/** Which row the desk's cancel is open on, and what a finished cancel does to the list. */
function useCancelling(list: ReturnType<typeof useUnsettled>, timezone: string) {
  const [cancelling, setCancelling] = useState<GridBooking | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const done = (outcome: CancelledOutcome) => {
    if (outcome.cancelledIds.length === 0) return;
    list.drop(outcome.cancelledIds);
    setNotice(COPY.cancelled);
    list.retry();
  };
  return {
    cancelling, notice, done,
    open: (row: UnsettledBooking) => setCancelling(toGridBooking(row, timezone)),
    close: (open: boolean) => { if (!open) setCancelling(null); },
  };
}

export default function AdminBookingsPage() {
  const list = useUnsettled();
  const timezone = list.page?.timezone ?? "UTC";
  const cancel = useCancelling(list, timezone);
  return (
    <PageShell width="full">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton onRefresh={list.retry} loading={list.loading} label={COPY.refresh} />}
        freshness={<Freshness at={list.readAt} />}
      />
      <UnsettledFilter page={list.page} />
      <p aria-live="polite" className="sr-only">{cancel.notice ?? ""}</p>
      {cancel.notice ? <Alert tone="success" live="off">{cancel.notice}</Alert> : null}
      <UnsettledList list={list} timezone={timezone} onCancel={cancel.open} />
      <CancelSheet
        open={cancel.cancelling !== null}
        onOpenChange={cancel.close}
        bookings={cancel.cancelling ? [cancel.cancelling] : []}
        isAdmin
        onCancelled={cancel.done}
        onStale={list.retry}
      />
    </PageShell>
  );
}

/** The filter (today one: never settled) with its count, and what deciding a row means. */
function UnsettledFilter({ page }: { page: UnsettledBookingsPage | null }) {
  return (
    <>
      <ToggleGroup type="single" aria-label={COPY.filterLabel} value="unsettled" className="w-fit rounded-lg bg-bg-muted p-1">
        <ToggleGroupItem value="unsettled">
          {COPY.filters.unsettled}
          {page ? <Badge tone="warning" className="ml-2">{page.total}</Badge> : null}
        </ToggleGroupItem>
      </ToggleGroup>
      {page ? <p className="max-w-prose text-sm text-text-secondary">{COPY.explain(page.lookback_days)}</p> : null}
    </>
  );
}

type ListProps = { list: ReturnType<typeof useUnsettled>; timezone: string; onCancel: (row: UnsettledBooking) => void };

function UnsettledList({ list, timezone, onCancel }: ListProps) {
  const showMore = usePagedFocus("[data-unsettled-bookings] > li", list.more.run);
  return (
    <StateBlock
      loading={list.loading}
      error={list.error}
      action={COPY.readAction}
      onRetry={list.retry}
      empty={!list.loading && !list.error && list.items.length === 0}
      emptyIcon={CalendarCheck}
      emptyTitle={COPY.emptyTitle}
      emptyHint={COPY.emptyHint}
      skeleton={<div className="flex flex-col gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>}
    >
      <ul data-unsettled-bookings="" className="grid gap-3 lg:grid-cols-2" aria-busy={list.more.pending || undefined}>
        {list.items.map((row) => <UnsettledRow key={row.booking_id} row={row} timezone={timezone} onCancel={onCancel} />)}
      </ul>
      {list.more.error ? <Alert tone="danger">{COPY.moreFailed}</Alert> : null}
      {list.cursor ? <div><Button variant="outline" pending={list.more.pending} onClick={showMore}>{COPY.more}</Button></div> : null}
    </StateBlock>
  );
}

type RowProps = { row: UnsettledBooking; timezone: string; onCancel: (row: UnsettledBooking) => void };

function UnsettledRow({ row, timezone, onCancel }: RowProps) {
  const name = row.member?.name ?? COPY.unknownMember;
  const court = row.court_name ?? COPY.unknownCourt;
  const when = clubDayAndClock(row.starts_at, timezone);
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar size={40} className="size-10 shrink-0">
          {row.member?.photo_url ? <AvatarImage src={row.member.photo_url} alt="" /> : null}
          <AvatarFallback name={name} />
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <span className="font-semibold text-text-primary">{name}</span>
          <span className="text-sm text-text-secondary">{court + " · " + when}</span>
          <span className="text-sm text-text-secondary">{COPY.charged(row.charged_minutes)}</span>
          {row.payer?.name ? <span className="text-sm text-text-muted">{COPY.paidBy(row.payer.name)}</span> : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {row.member ? (
          <Button asChild variant="outline" size="sm">
            <Link to={`/admin/members/${encodeURIComponent(row.member.user_id)}/bookings?when=past`}>{COPY.openMember}</Link>
          </Button>
        ) : null}
        <Button variant="danger-soft" size="sm" aria-label={COPY.cancelFor(court, when)} onClick={() => onCancel(row)}>{COPY.cancel}</Button>
      </div>
    </li>
  );
}
