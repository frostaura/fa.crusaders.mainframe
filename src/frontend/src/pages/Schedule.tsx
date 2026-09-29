import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ActionBar, ActionBarItem } from "@/components/ui/action-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { formatClubDayLabel } from "@/components/ui/date-picker-day";
import { IconButton } from "@/components/ui/icon-button";
import { CheckSquare, SquaresFour } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { StateBlock } from "@/components/ui/state-block";
import { WeekStrip } from "@/components/ui/week-strip";
import { useToast } from "../components/Toast";
import { ScheduleNotices } from "../components/ScheduleNotices";
import type { BoardContext } from "../components/ScheduleCells";
import { BookingBoard, BookingGridHeading, BookingGridSkeleton, SELECTION_ROOM_PX } from "../components/bookings/BookingGrid";
import { BookSheet, type BookedOutcome } from "../components/bookings/BookSheet";
import { CancelSheet, type CancelledOutcome } from "../components/bookings/CancelSheet";
import { InvitesBadgeLink } from "../components/players/invites/InvitesBadgeLink";
import type { GridBooking, SelectedSlot } from "../components/bookings/types";
import type { ScheduleCourt, ScheduleDay, ScheduleSlot } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { BOOKINGS_COPY, cancelSelectionLabel, selectionCapSentence, selectionDetail, selectionHeadline } from "../lib/bookingsCopy";
import { clubClock } from "../lib/clubClock";
import { useGridExplainer } from "../lib/gridExplain";
import {
  freeCount, gridBookingOf, parseSelectionKey, pendingBookingId, toGridBookings, toSelectedSlots, useGridSelection, type Selection,
} from "../lib/gridSelection";
import { useScheduleDay } from "../lib/scheduleDay";
import { useHoldLift } from "../lib/scheduleEnd";

/**
 * Bookings — the week strip, the grid and the two sheets it opens (R1–R6, D8).
 *
 * <p>
 * <b>A tap books one; a selection books many — for everyone (D8).</b> The toolbar's select
 * toggle, a long press, a desktop's hover checkbox, a drag and Shift+click are five ways into
 * one selection; a floating action bar over the tab bar carries it. The grid pre-filters what it
 * can (past, taken, closed, group window, peak, the member's daily cap); the server refuses the
 * rest per item and the sheet shows each outcome.
 * </p>
 *
 * <p>
 * <b>The sheets own the money.</b> `BookSheet` and `CancelSheet` quote, confirm and write; the
 * page only paints their outcome before its confirming read of the day lands, and hands the
 * viewer's own new balance to the chip. Admin "book as" (and `?as=<userId>` from a member's
 * page) lives in the sheet, never on the grid.
 * </p>
 */
export default function BookingsPage() {
  const auth = useAuth();
  const toast = useToast();
  const { balance, refresh: refreshBalance, apply: applyBalance } = useBalance();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  const actorUserId = auth.status === "authenticated" ? auth.userId : null;
  const [params] = useSearchParams();

  const schedule = useScheduleDay(isAdmin, params.get("date"));
  const { date, day, setDay, rules, reconcile, today } = schedule;
  useDateInUrl(date, today);
  // The day on screen must be the day asked for: a grid still showing Monday under Tuesday's
  // strip is worse than a skeleton.
  const shown = day && day.date === date ? day : null;

  const explainer = useGridExplainer(day, rules);
  const selection = useGridSelection({
    cap: isAdmin || rules.adminExempt ? null : rules.remainingToday,
    announce: explainer.announce, capSentence: selectionCapSentence,
    onSentence: BOOKINGS_COPY.selectionOn, offSentence: BOOKINGS_COPY.selectionOff,
  });
  useClearOnDayChange(date, selection, explainer);

  const sheets = useSheets();
  const liftHold = useHoldLift({ day, setDay, reconcile, toast });
  // Keyed on the day, so moving to another day folds the past wall away again by itself.
  const [earlierShownFor, setEarlierShownFor] = useState<string | null>(null);
  const showEarlier = earlierShownFor === date;

  const onBooked = useCallback((outcome: BookedOutcome) => {
    setDay((d) => withBooked(d, outcome));
    if (outcome.ownBalanceAfter !== null) applyBalance(outcome.ownBalanceAfter);
    if (selection.api.active) selection.api.leave();
    void reconcile();
  }, [setDay, applyBalance, selection.api, reconcile]);

  const onCancelled = useCallback((outcome: CancelledOutcome) => {
    setDay((d) => (d ? { ...d, slots: d.slots.filter((s) => !s.bookingId || !outcome.cancelledIds.includes(s.bookingId)) } : d));
    if (outcome.ownMoneyMoved) void refreshBalance({ expectSelf: true });
    if (selection.api.active) selection.api.leave();
    void reconcile();
  }, [setDay, refreshBalance, selection.api, reconcile]);

  const { openBook, openCancel } = sheets;
  const ctx = useMemo<BoardContext | null>(() => (shown ? {
    day: shown, rules, isAdmin, explain: explainer.explain, selection: selection.api, onLiftHold: liftHold,
    onBook: (court: ScheduleCourt, startsAtUtc: string) => openBook([oneSlot(court, startsAtUtc)]),
    onOpenBooking: (slot: ScheduleSlot) => openCancel([gridBookingOf(slot, shown)]),
  } : null), [shown, rules, isAdmin, explainer.explain, selection.api, liftHold, openBook, openCancel]);

  const collapsed = explainer.collapsedRows(schedule.timeSlices, schedule.pastThresholdMs, showEarlier, isAdmin, schedule.slotsByCourt);

  return (
    <PageShell width="wide">
      <PageHeader
        title={BOOKINGS_COPY.title}
        actions={(
          <>
            <SelectToggle selection={selection} />
            <RefreshButton label={BOOKINGS_COPY.refresh} onRefresh={schedule.refresh} loading={schedule.loading} />
          </>
        )}
        freshness={<Freshness at={schedule.readAt} />}
      />
      {/* Room under the grid while the floating bar is up, so it never covers the last row —
          padding, not a spacer element, because a spacer would also take the shell's section gap. */}
      <div className="flex flex-col gap-4" style={selection.api.active ? { paddingBottom: SELECTION_ROOM_PX } : undefined}>
        <InvitesBadgeLink />
        <DayPicker schedule={schedule} isAdmin={isAdmin} quota={explainer.quotaPill} rateLine={explainer.rateLine} />
        <ScheduleNotices
          notices={explainer.notices(balance, shown, isAdmin)} live={explainer.live} shown={explainer.shown}
          onDismiss={explainer.dismiss} onNextDay={schedule.nextDay}
        />
        <BookingGridHeading />
        <StateBlock
          loading={!shown && schedule.loading}
          error={shown ? null : schedule.error}
          action={BOOKINGS_COPY.loadAction}
          onRetry={schedule.refresh}
          empty={Boolean(shown && shown.courts.length === 0)}
          emptyTitle={BOOKINGS_COPY.noCourts}
          emptyHint={BOOKINGS_COPY.noCourtsHint}
          emptyIcon={SquaresFour}
          skeleton={<BookingGridSkeleton courts={day?.courts.length || 3} />}
        >
          {ctx ? (
            <BookingBoard
              ctx={ctx} slotsByCourt={schedule.slotsByCourt} timeSlices={schedule.timeSlices}
              pastThresholdMs={schedule.pastThresholdMs} peakNowMs={schedule.peakNowMs}
              collapsedRows={collapsed.rows} earlierLabel={collapsed.label} onExpandEarlier={() => setEarlierShownFor(date)}
              showNow={date === today}
            />
          ) : null}
        </StateBlock>
      </div>
      <SelectionBar selection={selection} day={shown} onBook={openBook} onCancel={openCancel} />
      <BookSheet
        open={sheets.bookOpen} onOpenChange={sheets.setBookOpen} slots={sheets.bookSlots}
        timezone={day?.timezone ?? "UTC"} sliceMinutes={day?.sliceMinutes ?? 15}
        isAdmin={isAdmin} actorUserId={actorUserId} balanceCredits={balance}
        bookAsUserId={isAdmin ? params.get("as") : null}
        onBooked={onBooked} onStale={() => void reconcile()}
      />
      <CancelSheet
        open={sheets.cancelOpen} onOpenChange={sheets.setCancelOpen} bookings={sheets.cancelBookings}
        isAdmin={isAdmin} onCancelled={onCancelled} onStale={() => void reconcile()}
      />
    </PageShell>
  );
}

/* ─────────────────────────────── the header's toggle ─────────────────────────────── */

function SelectToggle({ selection }: { selection: Selection }) {
  const on = selection.api.active;
  return (
    <IconButton
      label={on ? BOOKINGS_COPY.selectOff : BOOKINGS_COPY.selectOn}
      aria-pressed={on}
      variant={on ? "secondary" : "ghost"}
      onClick={selection.toggleMode}
    >
      <CheckSquare weight={on ? "fill" : "regular"} aria-hidden="true" />
    </IconButton>
  );
}

/* ─────────────────────────────── the day picker ─────────────────────────────── */

type ScheduleState = ReturnType<typeof useScheduleDay>;

/**
 * On a phone the jump-to-date trigger is a 44px calendar button — the strip under it already
 * says which day it is, and the month beside the arrows needs the room. Its name still carries
 * the day ("Jump to a date: Wed 23 Sep"). From `sm` it reads the day as well.
 */
const DATE_TRIGGER = "ml-1 w-11 shrink-0 justify-center px-0 sm:w-auto sm:px-3 [&>span]:sr-only sm:[&>span]:not-sr-only";

/**
 * The week strip — today selected by default, the past greyed for a member (R5) — with a
 * date-picker trigger beside the week arrows to jump further ahead, and the quiet facts a member
 * needs before they pick: how much of today's quota is gone, and whose rate they book at.
 */
function DayPicker(props: {
  schedule: ScheduleState; isAdmin: boolean;
  quota: { text: string; atLimit: boolean } | null; rateLine: string | null;
}) {
  const { schedule, isAdmin, quota, rateLine } = props;
  const { date, setDate, bounds, today } = schedule;
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
      <WeekStrip
        value={date} onChange={setDate} min={bounds.min} max={bounds.max} today={today}
        disablePast={!isAdmin} label={BOOKINGS_COPY.dayStripLabel} className="w-full lg:max-w-xl"
        trailing={(
          <DatePicker label={BOOKINGS_COPY.jumpToDate} value={date} onChange={setDate}
            min={bounds.min} max={bounds.max} timeZone={schedule.day?.timezone} className={DATE_TRIGGER} />
        )}
      />
      {quota || rateLine ? (
        <div className="flex flex-wrap items-center gap-2 lg:justify-end lg:pb-2">
          {rateLine ? <p className="text-sm text-text-secondary">{rateLine}</p> : null}
          {/* Approaching a limit is not a warning; only arriving at it is. */}
          {quota ? <Badge tone={quota.atLimit ? "warning" : "neutral"}>{quota.text}</Badge> : null}
        </div>
      ) : null}
    </div>
  );
}

/* ─────────────────────────────── the selection bar ─────────────────────────────── */

/**
 * The floating contextual bar (design-system.md, Patterns → Multiselect): × leaves the mode,
 * the headline counts free and booked apart with the total, the detail line names the day,
 * courts and span, and the actions sit on the right — Cancel for ticked bookings, Book for
 * ticked slots. Next in DOM order after the grid, so Tab out of the grid lands on it.
 */
function SelectionBar(props: {
  selection: Selection; day: ScheduleDay | null;
  onBook: (slots: SelectedSlot[]) => void; onCancel: (bookings: GridBooking[]) => void;
}) {
  const { selection, day, onBook, onCancel } = props;
  if (!selection.api.active) return null;
  const slots = toSelectedSlots(selection.keys, day);
  const bookings = toGridBookings(selection.keys, day);
  const free = freeCount(selection.keys);
  const total = slots.reduce((sum, s) => sum + s.priceCredits, 0);
  const headline = selection.keys.length ? selectionHeadline(free, total, bookings.length) : BOOKINGS_COPY.chooseSlots;
  return (
    <ActionBar
      count={selection.keys.length} countLabel={headline} detail={describeSpan(selection.keys, day)}
      onClose={selection.api.leave} closeLabel={BOOKINGS_COPY.clearSelection} label={BOOKINGS_COPY.actionBarLabel}
    >
      {bookings.length > 0 ? (
        <ActionBarItem asChild>
          <Button variant="danger-soft" onClick={() => onCancel(bookings)}>{cancelSelectionLabel(bookings.length)}</Button>
        </ActionBarItem>
      ) : null}
      {slots.length > 0 ? (
        <ActionBarItem asChild>
          <Button onClick={() => onBook(slots)}>{BOOKINGS_COPY.bookSelection}</Button>
        </ActionBarItem>
      ) : null}
    </ActionBar>
  );
}

type Place = { courtId: string; from: number; to: number };

/** Where one selection key sits on the day: its court, its first instant and its end. */
function placeOf(key: string, day: ScheduleDay): Place | null {
  const target = parseSelectionKey(key);
  if (target?.kind === "free") {
    const from = Date.parse(target.startsAtUtc);
    return { courtId: target.courtId, from, to: from + day.sliceMinutes * 60_000 };
  }
  if (target?.kind !== "booked") return null;
  const slot = day.slots.find((s) => s.bookingId === target.bookingId);
  return slot ? { courtId: slot.courtId, from: Date.parse(slot.startsAtUtc), to: Date.parse(slot.endsAtUtc) } : null;
}

/**
 * "Mon 9 Sep · Court 1, Court 2 · 16:00–16:45" — checkable without scrolling. The span runs to
 * the END of the last slot: three 15-minute slots from 16:00 are played until 16:45, and a bar
 * that said "16:00–16:30" would undersell what is about to be charged.
 */
function describeSpan(keys: readonly string[], day: ScheduleDay | null): string | undefined {
  if (!day) return undefined;
  const places = keys.map((k) => placeOf(k, day)).filter((p): p is Place => p !== null);
  if (places.length === 0) return undefined;
  const courtIds = new Set(places.map((p) => p.courtId));
  const courts = day.courts.filter((c) => courtIds.has(c.id)).map((c) => c.name);
  const from = clubClock(Math.min(...places.map((p) => p.from)), day.timezone);
  const to = clubClock(Math.max(...places.map((p) => p.to)), day.timezone);
  return selectionDetail(formatClubDayLabel(day.date) ?? "", courts, from, to);
}

/* ─────────────────────────────── state ─────────────────────────────── */

/** The two sheets' state. What they were opened with is kept while they close, so they animate out whole. */
function useSheets() {
  const [bookSlots, setBookSlots] = useState<SelectedSlot[]>([]);
  const [bookOpen, setBookOpen] = useState(false);
  const [cancelBookings, setCancelBookings] = useState<GridBooking[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const openBook = useCallback((slots: SelectedSlot[]) => { setBookSlots(slots); setBookOpen(true); }, []);
  const openCancel = useCallback((bookings: GridBooking[]) => { setCancelBookings(bookings); setCancelOpen(true); }, []);
  return { bookSlots, bookOpen, setBookOpen, cancelBookings, cancelOpen, setCancelOpen, openBook, openCancel };
}

/**
 * `?date=` follows the strip, so a link, a refresh and the back button all land on the day the
 * member was looking at. Today is the default and is left out of the address.
 */
function useDateInUrl(date: string, today: string) {
  const [params, setParams] = useSearchParams();
  const wanted = date === today ? null : date;
  const current = params.get("date");
  useEffect(() => {
    // Only when it differs: every `setParams` is a navigation, and a navigation to the same
    // address still re-renders the page under it.
    if (current === wanted) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (wanted === null) next.delete("date");
      else next.set("date", wanted);
      return next;
    }, { replace: true });
  }, [current, wanted, setParams]);
}

/**
 * A selection that survived a date change would act on slots the viewer is no longer looking
 * at — on a bulk cancel, other people's money. It is cleared, and the reader is told why.
 */
function useClearOnDayChange(date: string, selection: Selection, explainer: { announce: (t: string) => void; dismiss: () => void }) {
  const last = useRef(date);
  const { clear, keys } = selection;
  const { announce, dismiss } = explainer;
  useEffect(() => {
    if (last.current === date) return;
    last.current = date;
    dismiss();
    if (keys.length) { clear(); announce(BOOKINGS_COPY.selectionClearedDayChange); }
  }, [date, keys.length, clear, announce, dismiss]);
}

/* ─────────────────────────────── painting outcomes ─────────────────────────────── */

function oneSlot(court: ScheduleCourt, startsAtUtc: string): SelectedSlot {
  return { courtId: court.id, courtName: court.name, startsAt: startsAtUtc, sliceCount: 1, priceCredits: court.slicePriceCredits };
}

/**
 * The booked slots, painted before the confirming read lands. Ids are provisional — the read
 * replaces every one of them within a round trip — and a hold is drawn as a hold. Until then the
 * grid draws them as pending and will not act on them (`isPendingBooking`).
 */
function withBooked(day: ScheduleDay | null, outcome: BookedOutcome): ScheduleDay | null {
  if (!day) return day;
  const sliceMs = day.sliceMinutes * 60_000;
  const added: ScheduleSlot[] = outcome.booked.map((s) => ({
    courtId: s.courtId, courtNumber: day.courts.find((c) => c.id === s.courtId)?.courtNumber ?? 0,
    startsAtUtc: s.startsAt, endsAtUtc: new Date(Date.parse(s.startsAt) + s.sliceCount * sliceMs).toISOString(),
    status: outcome.hold ? "adminblock" : "booked",
    ownerUserId: outcome.forMemberId, ownerFirstName: null, ownerPhotoUrl: null,
    isMine: !outcome.hold && !outcome.forMemberId,
    bookingId: pendingBookingId(s.courtId, s.startsAt), blockLabel: null, checkedIn: false,
    amountChargedCredits: outcome.hold ? null : s.priceCredits,
  }));
  return { ...day, slots: [...day.slots, ...added] };
}
