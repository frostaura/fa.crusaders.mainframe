import { useCallback, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { CancelSheet, type CancelledOutcome } from "@/components/bookings/CancelSheet";
import type { GridBooking } from "@/components/bookings/types";
import { Button } from "@/components/ui/button";
import { CalendarBlank } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { StateBlock } from "@/components/ui/state-block";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAuth } from "@/lib/auth";
import { useBalance } from "@/lib/balance";
import { clubClock } from "@/lib/clubClock";
import { memberDetailEndpoints, type BookingsWhen, type MemberBookingRow, type MemberBookingsPage } from "@/lib/memberDetailApi";
import { BOOKINGS_TAB_COPY as COPY, MEMBER_COPY } from "@/lib/memberDetailCopy";
import { DETAIL_LINKS } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { useRead } from "@/lib/useRead";
import { BookingLine, BookingListSkeleton } from "./parts";
import { bookingWhen, dayParts, zoneNow } from "./memberTime";
import { firstName, useMemberDetail } from "./useMemberDetail";

/**
 * Bookings — everything this member booked, upcoming or past, a page at a time.
 *
 * <p>
 * <b>"Load more", never page numbers.</b> The server pages by a keyset cursor over the start
 * instant, because an offset repeats or skips a row every time the member books while an admin
 * pages. The first page is read on arrival; each further page is appended, and a failure to read
 * one says the list ABOVE it is still complete — it never truncates what was already shown.
 * </p>
 *
 * <p>
 * <b>Cancelling from here is the grid's own CancelSheet</b> — the same quote, the same waiver
 * with a reason, the same member-named sentences — so a booking cancelled from a member's page
 * settles exactly as one cancelled from the grid.
 * </p>
 */
export function MemberBookings() {
  const { userId, detail, reload } = useMemberDetail();
  const [params, setParams] = useSearchParams();
  const when: BookingsWhen = params.get("when") === "past" ? "past" : "upcoming";
  const pages = useBookingPages(userId, when);
  const cancel = useCancel(userId, detail.full_name ?? detail.email, detail.photo_url, () => {
    pages.retry();
    void reload();
  });

  const setWhen = (next: string) => {
    if (next !== "upcoming" && next !== "past") return;
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      if (next === "past") out.set("when", "past"); else out.delete("when");
      return out;
    }, { replace: true });
  };

  return (
    <Section
      title={COPY.title}
      actions={(
        <ToggleGroup type="single" aria-label={COPY.whenLabel} value={when} onValueChange={setWhen} className="rounded-lg bg-bg-muted p-1">
          <ToggleGroupItem value="upcoming">{COPY.upcoming}</ToggleGroupItem>
          <ToggleGroupItem value="past">{COPY.past}</ToggleGroupItem>
        </ToggleGroup>
      )}
    >
      <BookingPagesView pages={pages} when={when} canBook={detail.status === "Active"} userId={userId} onCancel={cancel.open} />
      <CancelSheet
        open={cancel.isOpen}
        onOpenChange={cancel.setOpen}
        bookings={cancel.bookings}
        isAdmin
        onCancelled={cancel.done}
        onStale={pages.retry}
      />
    </Section>
  );
}

type Pages = ReturnType<typeof useBookingPages>;

function BookingPagesView(props: {
  pages: Pages; when: BookingsWhen; canBook: boolean; userId: string; onCancel: (row: MemberBookingRow) => void;
}) {
  const { pages, when, canBook, userId, onCancel } = props;
  const zone = zoneNow();
  const upcoming = when === "upcoming";
  return (
    <StateBlock
      loading={pages.loading}
      error={pages.error}
      action={COPY.loadAction}
      failedCaveat={COPY.failedCaveat}
      onRetry={pages.retry}
      empty={!pages.loading && !pages.error && pages.items.length === 0}
      emptyIcon={CalendarBlank}
      emptyTitle={upcoming ? COPY.emptyUpcoming : COPY.emptyPast}
      emptyHint={upcoming ? COPY.emptyUpcomingHint : COPY.emptyPastHint}
      emptyAction={upcoming && canBook ? (
        <Button asChild variant="outline"><Link to={`/bookings?as=${encodeURIComponent(userId)}`}>{MEMBER_COPY.bookFor}</Link></Button>
      ) : null}
      skeleton={<BookingListSkeleton />}
    >
      <ul className="flex flex-col gap-3" aria-busy={pages.more.pending || undefined}>
        {pages.items.map((row) => (
          <BookingLine
            key={row.booking_id}
            row={row}
            zone={zone}
            action={(
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link
                    to={`/bookings/${row.booking_id}`}
                    aria-label={DETAIL_LINKS.openFor(row.court_name ?? COPY.unknownCourt, bookingWhen(row, zone))}
                  >
                    {DETAIL_LINKS.open}
                  </Link>
                </Button>
                {cancellable(row) ? (
                  <Button
                    variant="danger-soft"
                    size="sm"
                    aria-label={COPY.cancelFor(row.court_name ?? COPY.unknownCourt, bookingWhen(row, zone))}
                    onClick={() => onCancel(row)}
                  >
                    {COPY.cancel}
                  </Button>
                ) : null}
              </div>
            )}
          />
        ))}
      </ul>
      {pages.more.error ? <Alert tone="danger">{COPY.loadMoreFailed}</Alert> : null}
      {pages.cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" pending={pages.more.pending} onClick={() => void pages.more.run()}>{COPY.loadMore}</Button>
        </div>
      ) : null}
    </StateBlock>
  );
}

/** A booking the desk may still cancel: booked, and nobody has switched the lights on. */
function cancellable(row: MemberBookingRow): boolean {
  // A partner's seat is on somebody else's booking: cancelling it here would cancel THEIR game
  // (C6). The seat is managed from the booking itself.
  if (row.role === "partner") return false;
  return row.status === "booked" && !row.checked_in_at && Date.parse(row.ends_at) > Date.now();
}

/* ─────────────────────────────── the pages ─────────────────────────────── */

type Extra = { base: MemberBookingsPage | null; items: MemberBookingRow[]; cursor: string | null };

/**
 * The first page through `useRead` (keyed, three states), and the pages after it appended to
 * THAT first page. The appended rows remember which first page they follow, so a retry or a
 * switch between upcoming and past can never splice one list's tail onto another's head.
 */
function useBookingPages(userId: string, when: BookingsWhen) {
  const load = useCallback(() => memberDetailEndpoints.bookings(userId, { when }), [userId, when]);
  const [first, retry] = useRead(`${userId}:${when}`, load);
  const [extra, setExtra] = useState<Extra>({ base: null, items: [], cursor: null });
  const base = first.data;
  const follows = base !== null && extra.base === base;
  const cursor = follows ? extra.cursor : base?.next_cursor ?? null;

  const more = useAsyncAction(async () => {
    if (!base || !cursor) return;
    const page = await memberDetailEndpoints.bookings(userId, { when, cursor });
    setExtra((prev) => ({
      base,
      items: [...(prev.base === base ? prev.items : []), ...page.items],
      cursor: page.next_cursor,
    }));
  });

  return {
    items: [...(base?.items ?? []), ...(follows ? extra.items : [])],
    cursor,
    loading: first.loading,
    error: first.error,
    retry,
    more,
  };
}

/* ─────────────────────────────── cancelling ─────────────────────────────── */

/** The grid's sheet wants a `GridBooking`; this is the member's row, said the same way. */
function toGridBooking(row: MemberBookingRow, mine: boolean, name: string, photo: string | null): GridBooking {
  const zone = zoneNow();
  const d = dayParts(row.starts_at, zone);
  return {
    bookingId: row.booking_id,
    courtId: row.court_id,
    courtName: row.court_name ?? COPY.unknownCourt,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    whenLabel: `${d.weekday} ${d.day} ${d.month}, ${clubClock(row.starts_at, zone)}`,
    mine,
    memberFirstName: mine ? null : firstName(name),
    memberPhotoUrl: mine ? null : photo,
    checkedIn: row.checked_in_at !== null,
    amountChargedCredits: row.charged_credits,
    timezone: zone,
  };
}

function useCancel(userId: string, name: string, photo: string | null, after: () => void) {
  const auth = useAuth();
  const { refresh: refreshOwnBalance } = useBalance();
  const self = auth.status === "authenticated" && auth.userId === userId;
  const [isOpen, setOpen] = useState(false);
  const [bookings, setBookings] = useState<GridBooking[]>([]);
  return {
    isOpen,
    setOpen,
    bookings,
    open: (row: MemberBookingRow) => {
      setBookings([toGridBooking(row, self, name, photo)]);
      setOpen(true);
    },
    done: (outcome: CancelledOutcome) => {
      if (outcome.cancelledIds.length > 0) after();
      // An admin cancelling their OWN booking from their own page moved their own wallet too.
      if (outcome.ownMoneyMoved) void refreshOwnBalance({ expectSelf: true });
    },
  };
}
