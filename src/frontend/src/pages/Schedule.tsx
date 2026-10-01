import { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { StaleNotice } from "../components/shell/StaleNotice";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";
import { isConnectionFailure } from "../lib/offline/useCachedRead";
import { phoneIsOffline } from "../lib/api";
import type { BoardContext } from "../components/ScheduleCells";
import { BookingBoard, BookingGridHeading, BookingGridSkeleton, SELECTION_ROOM_PX } from "../components/bookings/BookingGrid";
import { BookSheet, type BookedOutcome } from "../components/bookings/BookSheet";
import { BookingForBar } from "../components/bookings/BookingForBar";
import { useBookingFor, type BookingFor } from "../components/bookings/useBookingFor";
import { UpcomingGames } from "../components/bookings/UpcomingGames";
import { useScheduleLiveness } from "../components/bookings/useScheduleLiveness";
import { RecentGames } from "../components/bookings/RecentGames";
import type { CancelledOutcome } from "../components/bookings/CancelSheet";
import { LazyCancelSheet, loadCancelSheet, usePrefetchWhen } from "../components/bookings/lazyParts";
import { InvitesBadgeLink } from "../components/players/invites/InvitesBadgeLink";
import type { GridBooking, SelectedSlot } from "../components/bookings/types";
import type { ScheduleCourt, ScheduleDay, ScheduleSlot } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { BOOKINGS_COPY, cancelSelectionLabel, selectionCapSentence, selectionCapShort, selectionHeadline } from "../lib/bookingsCopy";
import { firstNameOf, memberGridRules } from "../lib/bookingsApi";
import { describePlaces, type Place } from "../lib/bookingSpan";
import { clubClock } from "../lib/clubClock";
import { useGridExplainer, type ForMember } from "../lib/gridExplain";
import {
  freeCount, gridBookingOf, parseSelectionKey, pendingBookingId, selectionKey, toGridBookings, toSelectedSlots, useGridSelection, type Selection,
} from "../lib/gridSelection";
import { useScheduleDay } from "../lib/scheduleDay";
import { useHoldLift } from "../lib/scheduleEnd";
import { useSheetHistory } from "../lib/bookingSheetHistory";
import { focusAfterAction } from "../lib/focusAfterAction";
import { gridTabStop } from "../lib/useGridInteractions";

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
  // `?as=<member>` from a member's page — the desk booking for them (an admin's only).
  const bookAsUserId = isAdmin ? params.get("as") : null;

  const schedule = useScheduleDay(isAdmin, params.get("date"));
  const { date, day, setDay, rules, reconcile, today } = schedule;
  useDateInUrl(date, today);
  // The day on screen must be the day asked for: a grid still showing Monday under Tuesday's
  // strip is worse than a skeleton.
  const shown = day && day.date === date ? day : null;

  // F1.7 — the quota and the cap are the SHOWN day's: "today" only when it is.
  const otherDay = date === today ? null : formatClubDayLabel(date) ?? null;
  // R2 F1-3 — booking FOR a member, the grid draws that member's group hours: a cell their
  // groups would refuse is locked before Continue, not refused after it.
  const bookingFor = useBookingFor(bookAsUserId, date);
  const forMember = useForMember(bookingFor);
  const gridRules = forMember?.rules ?? rules;
  const explainer = useGridExplainer(day, rules, otherDay, forMember);
  const capSentence = useCallback((cap: number) => selectionCapSentence(cap, otherDay), [otherDay]);
  const capShort = useCallback((cap: number) => selectionCapShort(cap, otherDay), [otherDay]);
  const selection = useGridSelection({
    cap: isAdmin || rules.adminExempt ? null : rules.remainingToday,
    announce: explainer.announce, capSentence, capShort,
    onSentence: BOOKINGS_COPY.selectionOn, offSentence: BOOKINGS_COPY.selectionOff,
  });
  useClearOnDayChange(date, selection, explainer);

  const sheets = useSheets();
  usePrefetchWhen(shown !== null, loadCancelSheet);
  const { sending, setSending } = sheets;
  const holding = useMemo(() => holdingKeys(sending, day?.sliceMinutes ?? 15), [sending, day?.sliceMinutes]);
  const liftHold = useHoldLift({ day, setDay, reconcile, toast });
  // Keyed on the day, so moving to another day folds the past wall away again by itself.
  const [earlierShownFor, setEarlierShownFor] = useState<string | null>(null);
  const showEarlier = earlierShownFor === date;

  // Bumped by every booking and cancellation, so the upcoming list re-reads (F1.12).
  const [changes, setChanges] = useState(0);
  // R4 M4-3 — what OTHER people do to this member's games (an organiser cancelling, a partner
  // answering) reaches the page too: on a wallet-stream move and on coming back into view.
  const rereadAll = useCallback(() => { startTransition(() => setChanges((n) => n + 1)); void reconcile(); }, [reconcile]);
  const liveness = useScheduleLiveness(schedule.readAt, rereadAll);
  const { wrote } = liveness;

  const onBooked = useCallback((outcome: BookedOutcome) => {
    wrote();
    // Perf: the sheet's confirmation is drawn from the booking's own answer, and it goes up
    // FIRST. Re-drawing ~250 cells and the games lists rode in the same commit and held the
    // "Court booked" back ~70–130 ms on a phone; as a transition they follow a frame later.
    startTransition(() => setChanges((n) => n + 1));
    if (selection.api.active) selection.api.leave();
    // Read off a fresh schedule after a lost reply (F1.1): the grid already has it, and nobody
    // stated the balance — ask for it.
    if (outcome.proven) {
      startTransition(() => setSending(null));
      if (!outcome.forMemberId && !outcome.hold) void refreshBalance({ expectSelf: true });
      return;
    }
    // "Holding…" becomes "Confirming…" in ONE commit, so the cell never flashes free between.
    startTransition(() => { setSending(null); setDay((d) => withBooked(d, outcome)); });
    if (outcome.ownBalanceAfter !== null) applyBalance(outcome.ownBalanceAfter);
    void reconcile();
  }, [setDay, applyBalance, refreshBalance, selection.api, reconcile, setSending, wrote]);

  const onCancelled = useCallback((outcome: CancelledOutcome) => {
    wrote();
    setChanges((n) => n + 1);
    setDay((d) => (d ? { ...d, slots: d.slots.filter((s) => !s.bookingId || !outcome.cancelledIds.includes(s.bookingId)) } : d));
    if (outcome.ownMoneyMoved) void refreshBalance({ expectSelf: true });
    if (selection.api.active) selection.api.leave();
    void reconcile();
  }, [setDay, refreshBalance, selection.api, reconcile, wrote]);

  const { openCancel } = sheets;
  // R4 wave B — a grid drawn from the phone because the club could not be reached books nothing:
  // a slot it shows free may have gone. The press says why instead of opening the sheet.
  const offlineGrid = schedule.stale && (isConnectionFailure(schedule.error) || phoneIsOffline());
  const openBook = useOnlineOnly(offlineGrid, sheets.openBook, toast);
  const ctx = useMemo<BoardContext | null>(() => (shown ? {
    day: shown, rules: gridRules, isAdmin, dayLabel: otherDay, forName: forMember?.name ?? null, explain: explainer.explain, selection: selection.api, onLiftHold: liftHold,
    onBook: (court: ScheduleCourt, startsAtUtc: string) => openBook([oneSlot(court, startsAtUtc)]),
    onOpenBooking: (slot: ScheduleSlot) => openCancel([gridBookingOf(slot, shown)]),
  } : null), [shown, gridRules, isAdmin, otherDay, forMember, explainer.explain, selection.api, liftHold, openBook, openCancel]);

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
        <StaleNotice stale={schedule.stale} readAt={schedule.readAt} offline={offlineGrid} extra={offlineGrid ? OFFLINE_COPY.gridStale : undefined} />
        {bookAsUserId
          ? <BookingForBar booking={bookingFor} sliceMinutes={day?.sliceMinutes ?? 15} />
          : (
            <>
              <UpcomingGames refreshKey={changes} fallbackZone={day?.timezone} />
              {/* R2 F1-1 — finished games, whose results are recorded here. */}
              <RecentGames refreshKey={changes} fallbackZone={day?.timezone} />
            </>
          )}
        <InvitesBadgeLink />
        <DayPicker schedule={schedule} isAdmin={isAdmin} quota={explainer.quotaPill} rateLine={explainer.rateLine} />
        <ScheduleNotices
          notices={explainer.notices(bookAsUserId ? null : balance, shown, isAdmin)} live={explainer.live} shown={explainer.shown}
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
              showNow={date === today} underSheet={sheets.underSheet} holding={holding}
            />
          ) : null}
        </StateBlock>
      </div>
      <SelectionBar selection={selection} day={shown} onBook={openBook} onCancel={openCancel} />
      <BookSheet
        open={sheets.bookOpen} onOpenChange={sheets.setBookOpen} slots={sheets.bookSlots}
        timezone={day?.timezone ?? "UTC"} sliceMinutes={day?.sliceMinutes ?? 15}
        isAdmin={isAdmin} actorUserId={actorUserId} balanceCredits={balance}
        bookAsUserId={bookAsUserId}
        onBooked={onBooked} onStale={() => void reconcile()} reread={reconcile} onCloseAutoFocus={sheets.returnFocus}
        onSending={setSending} onBusyChange={sheets.onBookBusy}
        cancelTerms={day ? { penaltyPct: day.penaltyPct, windowMinutes: day.penaltyWindowMinutes } : null}
      />
      {/* Perf — lazy: mounted from its first opening (and kept, so it closes whole), fetched at
          idle once the day is on screen. */}
      {sheets.cancelMounted ? (
        <Suspense fallback={null}>
          <LazyCancelSheet
            open={sheets.cancelOpen} onOpenChange={sheets.setCancelOpen} bookings={sheets.cancelBookings}
            isAdmin={isAdmin} onCancelled={onCancelled} onStale={() => void reconcile()} reread={reconcile}
            onCloseAutoFocus={sheets.returnFocus} onBusyChange={sheets.onCancelBusy}
          />
        </Suspense>
      ) : null}
    </PageShell>
  );
}

/** `open`, unless the grid on screen is the phone's copy — then the reason, as a toast. */
function useOnlineOnly<A extends unknown[]>(stale: boolean, open: (...args: A) => void, toast: ReturnType<typeof useToast>) {
  return useCallback((...args: A) => {
    if (stale) { toast.push({ tone: "warning", text: OFFLINE_COPY.bookNeedsConnection }); return; }
    open(...args);
  }, [stale, open, toast]);
}

/** The member being booked for, with the grid rules their groups set — null until known (R2 F1-3). */
function useForMember(booking: BookingFor): ForMember | null {
  const member = booking.state.status === "ready" ? booking.state.member : null;
  return useMemo(() => {
    const memberRules = memberGridRules(member);
    return member && memberRules ? { name: firstNameOf(member.name), rules: memberRules } : null;
  }, [member]);
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
 * From `lg` the strip takes the width the facts leave (R3 V-12: capped at 36rem, it stopped at
 * about x=608 over a 1215px grid).
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
        disablePast={!isAdmin} label={BOOKINGS_COPY.dayStripLabel} className="w-full lg:min-w-0 lg:flex-1"
        trailing={(
          <DatePicker label={BOOKINGS_COPY.jumpToDate} value={date} onChange={setDate}
            min={bounds.min} max={bounds.max} timeZone={schedule.day?.timezone} className={DATE_TRIGGER} />
        )}
      />
      {quota || rateLine ? (
        <div className="flex flex-wrap items-center gap-2 lg:max-w-xs lg:shrink-0 lg:justify-end lg:pb-2">
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
      count={selection.keys.length} countLabel={headline}
      // R4 M4-7 — a pick the daily cap refused is said HERE, where the member is looking.
      detail={selection.refusal ? <span data-cap-refusal="" className="text-warning-strong">{selection.refusal}</span> : describeSpan(selection.keys, day)}
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
 * that said "16:00–16:30" would undersell what is about to be charged. Slots that are not one
 * span are listed instead (F1.8) — see `lib/bookingSpan`.
 */
function describeSpan(keys: readonly string[], day: ScheduleDay | null): string | undefined {
  if (!day) return undefined;
  const places = keys.map((k) => placeOf(k, day)).filter((p): p is Place => p !== null);
  return describePlaces(places, {
    day: formatClubDayLabel(day.date) ?? "",
    courtName: (id) => day.courts.find((c) => c.id === id)?.name ?? "",
    clock: (ms) => clubClock(ms, day.timezone),
  });
}

/* ─────────────────────────────── state ─────────────────────────────── */

/** The two sheets' state. What they were opened with is kept while they close, so they animate out whole. */
function useSheets() {
  const [bookSlots, setBookSlots] = useState<SelectedSlot[]>([]);
  const [bookOpen, setBookOpen] = useState(false);
  const [cancelBookings, setCancelBookings] = useState<GridBooking[]>([]);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelMounted, setCancelMounted] = useState(false);
  // From a sheet's opening until its close has finished (its focus return) — see `BoardProps.underSheet`.
  const [underSheet, setUnderSheet] = useState(false);
  // The slots a booking is being sent for — "Holding…" on the grid until the club answers.
  const [sending, setSending] = useState<SelectedSlot[] | null>(null);
  const opener = useRef<Element | null>(null);
  const openBook = useCallback((slots: SelectedSlot[]) => { opener.current = document.activeElement; setUnderSheet(true); setBookSlots(slots); setBookOpen(true); }, []);
  const openCancel = useCallback((bookings: GridBooking[]) => {
    opener.current = document.activeElement; setUnderSheet(true); setCancelBookings(bookings); setCancelMounted(true); setCancelOpen(true);
  }, []);
  // R4 I4-1 — a sheet whose money write is on its way stays open, whatever asks it to close.
  const bookBusy = useRef(false);
  const cancelBusy = useRef(false);
  const onBookBusy = useCallback((busy: boolean) => { bookBusy.current = busy; }, []);
  const onCancelBusy = useCallback((busy: boolean) => { cancelBusy.current = busy; }, []);
  // F1.19 — the system Back closes an open sheet instead of leaving Bookings.
  useSheetHistory(bookOpen, () => (bookBusy.current ? false : setBookOpen(false)), "book");
  useSheetHistory(cancelOpen, () => (cancelBusy.current ? false : setCancelOpen(false)), "cancel");
  // A sheet closed while its booking was on its way leaves no answer to clear the mark with: the
  // cell goes back to what the day says, as it did before the mark existed.
  const returnFocus = useCallback((event: Event) => { setUnderSheet(false); setSending(null); backToGrid(event, opener.current); }, []);
  return {
    bookSlots, bookOpen, setBookOpen, cancelBookings, cancelOpen, cancelMounted, setCancelOpen, openBook, openCancel, returnFocus,
    underSheet, sending, setSending, onBookBusy, onCancelBusy,
  };
}

/**
 * R3 X-6 — a sheet closing after the grid has re-drawn the cell it was opened from (booked,
 * cancelled) gives focus back to the grid's tab stop — that cell's successor — never `<main>`.
 * The dialog's own return stands while the opener is still in the page (Escape before anything
 * changed, a selection bar that is still up). The pending cell is re-drawn again when the day's
 * confirming read lands, so `focusAfterAction` keeps watching and puts focus back on the stop.
 */
function backToGrid(event: Event, opener: Element | null) {
  if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) return;
  const stop = gridTabStop();
  if (!stop) return;
  event.preventDefault();
  stop.focus({ preventScroll: true });
  focusAfterAction(gridTabStop);
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
/** The grid cells a sending booking covers — every slice of every slot — as selection keys. */
function holdingKeys(sending: SelectedSlot[] | null, sliceMinutes: number): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const slot of sending ?? []) {
    const start = Date.parse(slot.startsAt);
    for (let i = 0; i < Math.max(1, slot.sliceCount); i++) {
      keys.add(selectionKey(slot.courtId, new Date(start + i * sliceMinutes * 60_000).toISOString()));
    }
  }
  return keys;
}

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
