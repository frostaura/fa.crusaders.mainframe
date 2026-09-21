import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endpoints, type ScheduleCourt, type ScheduleDay, type ScheduleSlot } from "../lib/api";
import { Card } from "../components/Card";
import { DayBar } from "../components/DayBar";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { formatCredits } from "../lib/utils";
import { ADMIN_SELF_SHORT_TEXT, describeBookingError, MEMBER_SHORT_TEXT, provesStaleGrid } from "../lib/bookingErrors";
import { ApiError } from "../lib/api";
import { BookingConfirmModal, type AdminOption, type BookingIntent, type BookingOutcome } from "../components/BookingConfirmModal";
import { CancelBookingModal } from "../components/CancelBookingModal";
import { ScheduleBoard, ScheduleGridHeading } from "../components/ScheduleCells";
import { ScheduleNotices } from "../components/ScheduleNotices";
import { SelectionBar } from "../components/SelectionBar";
import { BulkActionSheet } from "../components/BulkActionSheet";
import { useSlotEnders, type CancelTarget } from "../lib/scheduleEnd";
import { buildTimeSlices, groupSlotsByCourt } from "../lib/scheduleGrid";
import { clubDayAndClock } from "../lib/clubClock";
import { clubDayOf, gridNow, shiftClubDay } from "../lib/gridClock";
import { readViewerRules } from "../lib/gridRules";
import { useTicker } from "../lib/useTicker";
import { useGridSelection } from "../lib/gridSelection";
import { useGridExplainer } from "../lib/gridExplain";
import { describeFailure } from "../lib/errors";

/** A member the desk can book for, with the credit the club last read for them. */
export type MemberOption = { userId: string; name: string; balanceCredits: number | null };

/**
 * How often the grid re-reads the clock.
 *
 * <p>
 * <b>D3-B02.</b> "Now" used to be stamped once, at load, and every cell compared against that
 * stamp for the life of the tab — so a console left open on the club desk went on offering, and
 * charging for, slots that had already started. Ten seconds is the resolution; what it costs is
 * bounded by `gridNow`, which turns the tick into thresholds that move in slice and minute
 * steps, so the memoised grid still repaints at most once a minute.
 * </p>
 */
const GRID_TICK_MS = 10_000;

export default function SchedulePage() {
  const auth = useAuth();
  const toast = useToast();
  const { balance, refresh: refreshBalance, apply: applyBalance } = useBalance();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  // Who is acting. The member picker lists every active member INCLUDING the admin using it,
  // and §8's override is refused by the server when the actor and the payer are the same
  // person, so the screen has to know which row in that list is the actor's own.
  const actorUserId = auth.status === "authenticated" ? auth.userId : null;

  // D3-B03: the CLUB's day, not the browser's. `clubDayOf` falls back to the reader's clock
  // only while nobody has told us a zone — and the server's own answer overrides it below,
  // which is what makes a cold start right as well as a returning visit.
  const [date, setDate] = useState(() => clubDayOf(Date.now(), undefined));
  const [day, setDay] = useState<ScheduleDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState<BookingIntent | null>(null);
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [bulk, setBulk] = useState<"book" | "cancel" | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

  /**
   * The club day the grid is actually holding.
   *
   * <p>
   * <b>The SERVER's club day wins, and adopting it must not refetch.</b> D2-B33 defaults
   * `/schedule`'s date from the club day rather than from a UTC marker, and `clubDayOf` above
   * can only guess until the club has told this browser its zone — which on a cold start it has
   * not. So when the day that comes back is not the day that was asked for, the picker adopts
   * it. This ref is what stops that adoption looking like a date change and firing a second
   * day-sized read, which on a phone grid is the difference between a screen that settles and
   * one that flickers.
   * </p>
   */
  const loadedDate = useRef<string | null>(null);

  const load = useCallback(async (which: string) => {
    setLoading(true);
    setError(null);
    try {
      const fresh = await endpoints.schedule(which);
      loadedDate.current = fresh.date;
      setDay(fresh);
      if (fresh.date !== which) setDate(fresh.date);
    }
    // Was a bare `catch` mapping EVERY failure to "Check your connection and press Refresh."
    // — so a missing tenant row, a 500 and an expired session all told the member their
    // network was down, and Refresh was the one thing that could not help.
    catch (err) { setError(describeFailure(err, { action: "load the schedule" })); }
    finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { if (loadedDate.current !== date) void load(date); }, [date, load]);

  // Reconcile in the BACKGROUND after a write.
  //
  // The page used to await a full-day refetch (and a wallet read) before the member saw
  // anything change, so the cost of a booking was the POST plus two more round trips plus a
  // rebuild of every cell — with the member staring at a grid that still said the slot was
  // free. The write's own response says what happened, so the grid is patched from it
  // immediately and the authoritative read follows behind without being waited on.
  //
  // Silent on failure, deliberately, and this is the one place that is right: the write
  // SUCCEEDED. Telling a member who has just booked and been charged that the schedule could
  // not be loaded would be alarming and untrue.
  //
  // Returned, not fire-and-forget: a refusal that proves the grid is stale (L-F2) refetches and
  // AWAITS this before its sentence is shown.
  const reconcile = useCallback(() => {
    return endpoints.schedule(date)
      .then((fresh) => { loadedDate.current = fresh.date; setDay(fresh); })
      .catch(() => { /* the optimistic view stands until something asks for the day again */ });
  }, [date]);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    void fetchMembers().then((rows) => { if (live && rows) setMembers(rows); });
    return () => { live = false; };
  }, [isAdmin]);

  // A booking spends the credit the roster is quoting, so the quote moves with it — otherwise
  // the session's second booking states the balance from before its first.
  const refreshMembers = useCallback(() => {
    void fetchMembers().then((rows) => { if (rows) setMembers(rows); });
  }, []);

  const slotsByCourt = useMemo(() => groupSlotsByCourt(day), [day]);
  const timeSlices = useMemo(() => (day ? buildTimeSlices(day) : []), [day]);
  const rules = useMemo(() => readViewerRules(day), [day]);

  const tick = useTicker(true, GRID_TICK_MS);
  const rowStarts = useMemo(() => timeSlices.map((t) => Date.parse(t.utc)), [timeSlices]);
  const { pastThresholdMs, peakNowMs } = useMemo(() => gridNow(rowStarts, tick), [rowStarts, tick]);

  const dateBounds = useMemo(() => {
    const span = day?.advanceBookingDays ?? 14;
    // §5 "Date picker lets the player navigate ±N days". `min` was pinned to today for
    // everyone but an admin, so a member could only ever move forward — and with no bookings
    // list anywhere else in the product, there was no way to look at a booking they had
    // already played. Past days are read-only: every slot on them renders as Past.
    const today = clubDayOf(tick, day?.timezone);
    return {
      min: isAdmin ? undefined : shiftClubDay(today, -span),
      max: isAdmin ? undefined : shiftClubDay(today, span),
    };
  }, [isAdmin, day?.advanceBookingDays, day?.timezone, tick]);

  // Keyed on the DAY'S SHAPE, not on `day` — so these keep their identity while the page's
  // modal state moves, and change only when a new schedule arrives. That is what makes the
  // memo on the grid bite: a callback rebuilt on every render would hand the grid a new prop
  // each time and re-render two hundred cells to open a dialog.
  const timezone = day?.timezone ?? "UTC";
  const sliceMinutes = day?.sliceMinutes ?? 15;

  const openBooking = useCallback(
    (court: ScheduleCourt, startsAtUtc: string) => setBooking({
      courtId: court.id, courtName: court.name, startsAtUtc, priceCredits: court.slicePriceCredits,
      // D4 §2.4 — ONE clock across the journey. The grid says 06:30, and so does the dialog,
      // and so does the toast. `Intl.DateTimeFormat(undefined, …)` used to render
      // "Mon, Sep 21, 11:15 PM" here against a grid drawn in 24-hour club time, so a member
      // had to convert to be sure it was the same slot they had pressed.
      whenLabel: clubDayAndClock(startsAtUtc, timezone),
      sliceMinutes,
    }), [timezone, sliceMinutes]);

  const openCancel = useCallback((slot: ScheduleSlot, courtName: string) => setCancelling({
    bookingId: slot.bookingId!, courtName,
    whenLabel: clubDayAndClock(slot.startsAtUtc, timezone), mine: slot.isMine,
    // First name only — it is all the grid carries, and all it is allowed to.
    memberName: slot.isMine ? null : slot.ownerFirstName,
  }), [timezone]);

  const explainer = useGridExplainer(day, rules);
  const selection = useGridSelection(isAdmin, explainer.announce);
  // A selection that survived a date change would act on slots the admin is no longer looking
  // at — which on a bulk cancel is other people's money.
  const lastDate = useRef(date);
  useEffect(() => {
    if (lastDate.current === date) return;
    lastDate.current = date;
    setShowEarlier(false);
    if (selection?.keys.length) { selection.clear(); explainer.announce("Selection cleared — you changed day."); }
  }, [date, selection, explainer]);

  const confirmBooking = async (option: AdminOption): Promise<BookingOutcome> => {
    if (!booking) return { kind: "done" };
    try {
      const memberBalanceAfter = await placeBooking(
        booking, option, (slot) => setDay((d) => withSlot(d, slot)), applyBalance);
      toast.push({ tone: "success", text: bookedMessage(booking, option, memberBalanceAfter, nameOf(members, option)) });
      setBooking(null);
      reconcile();
      if (option.kind === "member") refreshMembers();
      return { kind: "done" };
    } catch (err) {
      // A member who cannot cover the court is not an error to report and dismiss — it is §8's
      // decision, and it goes back to the modal so the admin can take it with the figures in
      // front of them.
      const short = shortfallFrom(err, option, actorUserId);
      if (short) return short;
      // The server has just told us this day is not what we are showing.
      if (provesStaleGrid(err)) await reconcile();
      return { kind: "refused", message: refusalText(err, option, actorUserId) };
    }
  };

  // Cancelling a booking and lifting an admin block, both of which end a slot: same optimistic
  // removal, same reconcile, same failure copy. In their own hook because this page was over
  // the 200-line gate and these two are the most self-contained thing in it.
  const { confirmCancel, liftBlock } = useSlotEnders({
    cancelling, setCancelling, setDay, reconcile, refreshBalance, toast,
  });

  const collapsed = explainer.collapsedRows(timeSlices, pastThresholdMs, showEarlier, isAdmin, slotsByCourt);

  // Memoised, and that is what makes the grid's own memo bite. A context object rebuilt inline
  // in the JSX is a new prop on every render, so opening a dialog re-rendered two hundred
  // cells — measured at 28 ms in jsdom for a modal that touches no cell at all.
  const boardContext = useMemo(() => (day ? {
    day, rules, isAdmin, explain: explainer.explain,
    onBook: openBooking, onCancel: openCancel, onLiftBlock: liftBlock,
    selection: selection?.api ?? null,
  } : null), [day, rules, isAdmin, explainer.explain, openBooking, openCancel, liftBlock, selection?.api]);

  return (
    <div className="space-y-4">
      {/*
        C-M8 / R3-35 — this page had NO heading of any kind. A reader that jumps by heading had
        no way in, on the screen a member opens most often, and the route announcer above it
        moves focus to `#main-content h1` on every navigation.
      */}
      <h1 className="text-xl font-semibold">Bookings</h1>

      <DayBar
        date={date} bounds={dateBounds} loading={loading} timezone={day?.timezone}
        onDate={setDate} onRefresh={() => void load(date)}
        quota={explainer.quotaPill}
        rateLine={explainer.rateLine}
        selectable={Boolean(selection)}
        selecting={selection?.api.active ?? false}
        onToggleSelect={() => (selection?.api.active ? selection.exit() : selection?.enter())}
      />

      {error && <Card><p className="text-sm text-danger-strong">{error}</p></Card>}

      <ScheduleNotices notices={explainer.notices(balance, day)} live={explainer.live}
        onNextDay={() => setDate(shiftClubDay(date, 1))} />

      {day && <ScheduleGridHeading />}

      {day && boardContext && (
        <ScheduleBoard
          ctx={boardContext}
          slotsByCourt={slotsByCourt}
          timeSlices={timeSlices}
          pastThresholdMs={pastThresholdMs}
          peakNowMs={peakNowMs}
          collapsedRows={collapsed.rows}
          earlierLabel={collapsed.label}
          onExpandEarlier={() => setShowEarlier(true)}
        />
      )}

      {/* The bar appears while anything IS selected, never merely because the mode is on. An
          action strip reading "0 slots selected" with two dead buttons on it is furniture, and
          it costs the last row of the grid the padding it reserves. */}
      {selection && selection.keys.length > 0 && (
        <SelectionBar
          keys={selection.keys} day={day} slotsByCourt={slotsByCourt}
          onClear={selection.clear} onBook={() => setBulk("book")} onCancel={() => setBulk("cancel")}
        />
      )}

      {bulk && day && (
        <BulkActionSheet
          mode={bulk} day={day} keys={selection?.keys ?? []} members={members} actorUserId={actorUserId}
          onClose={() => setBulk(null)}
          onSettled={(done) => { selection?.drop(done); void reconcile(); void refreshBalance(); refreshMembers(); }}
        />
      )}

      {booking && (
        <BookingConfirmModal
          intent={booking} balanceCredits={balance} members={members} isAdmin={isAdmin}
          onCancel={() => setBooking(null)} onConfirm={confirmBooking}
        />
      )}

      {cancelling && (
        <CancelBookingModal
          bookingId={cancelling.bookingId} courtName={cancelling.courtName}
          whenLabel={cancelling.whenLabel} memberName={cancelling.memberName}
          asAdmin={isAdmin && !cancelling.mine}
          onClose={() => setCancelling(null)} onConfirm={confirmCancel}
        />
      )}
    </div>
  );
}

/**
 * The member picker for "book on behalf", carrying each member's balance so §8's four figures
 * — name, balance, price, balance after — are on the dialog before the desk spends somebody
 * else's credit.
 *
 * <p>
 * Admin-only, and it swallows its own failure: a member never asks for it, asking would be a
 * 403 on every schedule visit, and a desk whose roster did not load can still book for itself
 * and cancel.
 * </p>
 */
async function fetchMembers(): Promise<MemberOption[] | null> {
  try {
    const rows = await endpoints.adminMembers("Active");
    return rows.map((m) => ({
      userId: m.user_id, name: m.full_name,
      balanceCredits: typeof m.balance_credits === "number" ? m.balance_credits : null,
    }));
  } catch { return null; }
}

/**
 * Place the booking and hand back the slot it created, so the grid can show it before the
 * confirming read comes back. The balance comes from the same response — the wallet GET that
 * used to follow every booking was asking a question the POST had answered.
 */
async function placeBooking(
  intent: BookingIntent, option: AdminOption,
  addSlot: (slot: ScheduleSlot) => void, applyBalance: (credits: number) => void,
): Promise<number | null> {
  const base = {
    courtId: intent.courtId, courtNumber: 0,
    startsAtUtc: intent.startsAtUtc,
    endsAtUtc: new Date(Date.parse(intent.startsAtUtc) + intent.sliceMinutes * 60_000).toISOString(),
    ownerPhotoUrl: null, checkedIn: false,
  };
  if (option.kind === "block") {
    const r = await endpoints.adminBlock(intent.courtId, intent.startsAtUtc, 1, option.label);
    addSlot({
      ...base, status: "adminblock", ownerUserId: null, ownerFirstName: null,
      isMine: false, bookingId: r.booking_id, blockLabel: option.label, amountChargedCredits: null,
    });
    return null;
  }
  if (option.kind === "member") {
    const r = await endpoints.adminBook(
      intent.courtId, option.userId, intent.startsAtUtc, 1, option.allowNegativeBalance ?? false);
    addSlot({
      ...base, status: "booked", ownerUserId: option.userId, ownerFirstName: null,
      isMine: false, bookingId: r.booking_id, blockLabel: null, amountChargedCredits: intent.priceCredits,
    });
    // The MEMBER's balance, and deliberately not handed to applyBalance: the admin's own wallet
    // did not move, and overwriting it with somebody else's figure is the same wrong-wallet
    // mistake in the other direction.
    return r.balance_after_credits;
  }
  const r = await endpoints.book(intent.courtId, intent.startsAtUtc, 1);
  addSlot({
    ...base, status: "booked", ownerUserId: null, ownerFirstName: null,
    isMine: true, bookingId: r.booking_id, blockLabel: null, amountChargedCredits: intent.priceCredits,
  });
  applyBalance(r.balance_after_credits);
  return null;
}

/**
 * §8's override opportunity: an on-behalf booking the MEMBER cannot cover.
 *
 * <p>
 * Narrow on purpose. It fires only on the first attempt of a member-mode booking — an override
 * that is itself refused must not offer another override — and only when the server sent both
 * figures, because the whole value of the offer is that it states what the overdraft costs.
 * </p>
 */
function shortfallFrom(err: unknown, option: AdminOption, actorUserId: string | null): BookingOutcome | null {
  if (option.kind !== "member" || option.allowNegativeBalance) return null;
  // An admin who picked THEMSELVES out of the member list. The server's override is
  // `payer.AllowNegativeBalance && actorId != userId`, so this one cannot be granted — an actor
  // authorising their own overdraft is an unlimited credit line, not an override.
  if (option.userId === actorUserId) return null;
  if (!(err instanceof ApiError) || err.code !== "insufficient_balance") return null;
  const current = err.detail("current_credits");
  const required = err.detail("required_credits");
  if (typeof current !== "number" || typeof required !== "number") return null;
  return { kind: "short", currentCredits: current, requiredCredits: required };
}

/**
 * The refusal sentence, addressed to the wallet that is actually short.
 *
 * <p>
 * `insufficient_balance` reaches this screen for two different people. A member is told to top
 * up, which is what they can do about it. An admin booking on somebody else's behalf was told
 * to top up their own wallet — a desk account with a permanent balance of zero.
 * </p>
 */
function refusalText(err: unknown, option: AdminOption, actorUserId: string | null): string {
  const fallback = "Couldn't make that booking. Refresh the schedule and try again.";
  if (option.kind === "member" && err instanceof ApiError && err.code === "insufficient_balance") {
    return option.userId === actorUserId ? ADMIN_SELF_SHORT_TEXT : MEMBER_SHORT_TEXT;
  }
  return describeBookingError(err, fallback);
}

/** The name the desk picked from the dropdown, for the sentence that confirms what it did. */
function nameOf(members: MemberOption[], option: AdminOption): string {
  if (option.kind !== "member") return "";
  return members.find((m) => m.userId === option.userId)?.name ?? "that member";
}

function bookedMessage(
  intent: BookingIntent, option: AdminOption, memberBalanceAfter: number | null, memberName: string,
): string {
  if (option.kind === "block") return `${intent.courtName} held for "${option.label}" at ${intent.whenLabel}.`;
  if (option.kind === "member") {
    // Naming the resulting balance is the point of the override being deliberate: the admin who
    // has just put somebody in the red is told by how much, at the moment they did it.
    const owing = memberBalanceAfter !== null && memberBalanceAfter < 0
      ? ` ${memberName}'s balance is now ${formatCredits(memberBalanceAfter)} — they've been emailed about it.`
      : "";
    // Named, not "that member". The desk has just picked a name from a dropdown and spent that
    // person's credit; repeating the name back is the one check that catches a mis-click.
    return `Booked ${intent.courtName} at ${intent.whenLabel} for ${memberName}.${owing}`;
  }
  return `Booked ${intent.courtName} at ${intent.whenLabel}.`;
}

function withSlot(day: ScheduleDay | null, slot: ScheduleSlot): ScheduleDay | null {
  return day ? { ...day, slots: [...day.slots, slot] } : day;
}
