import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { endpoints, type ScheduleCourt, type ScheduleDay, type ScheduleSlot } from "../lib/api";
import { Card } from "../components/Card";
import { DayBar } from "../components/DayBar";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { BookingConfirmModal, type AdminOption, type BookingIntent, type BookingOutcome } from "../components/BookingConfirmModal";
import { CancelBookingModal } from "../components/CancelBookingModal";
import { ScheduleBoard, ScheduleGridHeading } from "../components/ScheduleCells";
import { ScheduleNotices } from "../components/ScheduleNotices";
import { SelectionBar } from "../components/SelectionBar";
import { BulkActionSheet } from "../components/BulkActionSheet";
import { useSlotEnders, type CancelTarget } from "../lib/scheduleEnd";
import { useBookingConfirm } from "../lib/scheduleBook";
import { useScheduleDay } from "../lib/scheduleDay";
import { clubDayAndClock } from "../lib/clubClock";
import { useGridSelection, type Selection } from "../lib/gridSelection";
import { useGridExplainer } from "../lib/gridExplain";

/**
 * The selection bar and whichever bulk sheet it opened — items 5 and 13.
 *
 * <p>
 * <b>The bar appears while anything IS selected, never merely because the mode is on.</b> An
 * action strip reading "0 slots selected" with two dead buttons on it is furniture, and it
 * costs the last row of the grid the padding it reserves.
 * </p>
 *
 * <p>
 * Out of the page body for the same reason as the dialogs below it: each is a conditional, and
 * the page has none to spare against the complexity gate.
 * </p>
 */
function ScheduleBulk(props: {
  selection: Selection | null;
  day: ScheduleDay | null;
  slotsByCourt: Map<string, ScheduleSlot[]>;
  bulk: "book" | "cancel" | null;
  setBulk: (m: "book" | "cancel" | null) => void;
  members: MemberOption[];
  actorUserId: string | null;
  onSettled: (doneKeys: string[]) => void;
}) {
  const { selection, day, slotsByCourt, bulk, setBulk } = props;
  return (
    <>
      {selection && selection.keys.length > 0 && (
        <SelectionBar
          keys={selection.keys} day={day} slotsByCourt={slotsByCourt}
          onClear={selection.clear} onBook={() => setBulk("book")} onCancel={() => setBulk("cancel")}
        />
      )}
      {bulk && day && (
        <BulkActionSheet
          mode={bulk} day={day} keys={selection?.keys ?? []} members={props.members}
          actorUserId={props.actorUserId}
          onClose={() => setBulk(null)}
          onSettled={props.onSettled}
        />
      )}
    </>
  );
}

/**
 * The two dialogs, mounted together.
 *
 * <p>
 * Out of the page body because each of them is a conditional branch, and a page that already
 * carries the day's state machine, a bulk sheet and a selection bar has no branches to spare
 * against the complexity gate. Nothing here holds state; both are driven entirely by the
 * page's.
 * </p>
 */
function ScheduleDialogs(props: {
  booking: BookingIntent | null;
  cancelling: CancelTarget | null;
  balanceCredits: number | null;
  members: MemberOption[];
  isAdmin: boolean;
  onCloseBooking: () => void;
  onConfirmBooking: (option: AdminOption) => Promise<BookingOutcome>;
  onCloseCancel: () => void;
  onConfirmCancel: (waivePenalty: boolean, waiveReason: string) => Promise<void>;
}) {
  const { booking, cancelling, balanceCredits, members, isAdmin } = props;
  return (
    <>
      {booking && (
        <BookingConfirmModal
          intent={booking} balanceCredits={balanceCredits} members={members} isAdmin={isAdmin}
          onCancel={props.onCloseBooking} onConfirm={props.onConfirmBooking}
        />
      )}
      {cancelling && (
        <CancelBookingModal
          bookingId={cancelling.bookingId} courtName={cancelling.courtName}
          whenLabel={cancelling.whenLabel} memberName={cancelling.memberName}
          asAdmin={isAdmin && !cancelling.mine}
          onClose={props.onCloseCancel} onConfirm={props.onConfirmCancel}
        />
      )}
    </>
  );
}

/** A member the desk can book for, with the credit the club last read for them. */
export type MemberOption = { userId: string; name: string; balanceCredits: number | null };

export default function SchedulePage() {
  const auth = useAuth();
  const toast = useToast();
  const { balance, refresh: refreshBalance, apply: applyBalance } = useBalance();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  // Who is acting. The member picker lists every active member INCLUDING the admin using it,
  // and §8's override is refused by the server when the actor and the payer are the same
  // person, so the screen has to know which row in that list is the actor's own.
  const actorUserId = auth.status === "authenticated" ? auth.userId : null;

  // The day, the clock against it and the two bugs that lived in both — in `lib/scheduleDay`,
  // because this page already carries two modals, a bulk sheet, four mutations and an
  // optimistic grid, and the complexity gate is what stops that growing unnoticed.
  const {
    date, setDate, nextDay, day, setDay, rules, error, loading, refresh, reconcile,
    slotsByCourt, timeSlices, pastThresholdMs, peakNowMs, bounds,
  } = useScheduleDay(isAdmin);

  const [booking, setBooking] = useState<BookingIntent | null>(null);
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [bulk, setBulk] = useState<"book" | "cancel" | null>(null);
  const [showEarlier, setShowEarlier] = useState(false);

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

  const confirmBooking = useBookingConfirm({
    booking, setBooking, setDay, reconcile, refreshMembers, applyBalance, toast,
    members, actorUserId,
  });

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
        date={date} bounds={bounds} loading={loading} timezone={day?.timezone}
        onDate={setDate} onRefresh={refresh}
        quota={explainer.quotaPill}
        rateLine={explainer.rateLine}
        selection={selection}
      />

      {error && <Card><p className="text-sm text-danger-strong">{error}</p></Card>}

      <ScheduleNotices notices={explainer.notices(balance, day)} live={explainer.live}
        onNextDay={nextDay} />

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

      <ScheduleBulk
        selection={selection} day={day} slotsByCourt={slotsByCourt} bulk={bulk} setBulk={setBulk}
        members={members} actorUserId={actorUserId}
        onSettled={(done) => { selection?.drop(done); void reconcile(); void refreshBalance(); refreshMembers(); }}
      />

      <ScheduleDialogs
        booking={booking} cancelling={cancelling}
        balanceCredits={balance} members={members} isAdmin={isAdmin}
        onCloseBooking={() => setBooking(null)} onConfirmBooking={confirmBooking}
        onCloseCancel={() => setCancelling(null)} onConfirmCancel={confirmCancel}
      />
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

