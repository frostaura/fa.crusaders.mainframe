import { useCallback, useEffect, useMemo, useState } from "react";
import { endpoints, type ScheduleDay, type ScheduleSlot } from "../lib/api";
import { Card } from "../components/Card";
import { DayBar } from "../components/DayBar";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/auth";
import { useBalance } from "../lib/balance";
import { formatCredits } from "../lib/utils";
import { ADMIN_SELF_SHORT_TEXT, describeBookingError, MEMBER_SHORT_TEXT } from "../lib/bookingErrors";
import { ApiError } from "../lib/api";
import { BookingConfirmModal, type AdminOption, type BookingIntent, type BookingOutcome } from "../components/BookingConfirmModal";
import { CancelBookingModal } from "../components/CancelBookingModal";
import { ScheduleBoard } from "../components/ScheduleCells";
import { useSlotEnders, type CancelTarget } from "../lib/scheduleEnd";
import { buildTimeSlices, groupSlotsByCourt } from "../lib/scheduleGrid";

const ymd = (d: Date) => d.toISOString().slice(0, 10);


/** A member the desk can book for, with the credit the club last read for them. */
type MemberOption = { userId: string; name: string; balanceCredits: number | null };

export default function SchedulePage() {
  const auth = useAuth();
  const toast = useToast();
  const { balance, refresh: refreshBalance, apply: applyBalance } = useBalance();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  // Who is acting. The member picker lists every active member INCLUDING the admin using
  // it, and §8's override is refused by the server when the actor and the payer are the
  // same person, so the screen has to know which row in that list is the actor's own.
  const actorUserId = auth.status === "authenticated" ? auth.userId : null;

  const today = useMemo(() => ymd(new Date()), []);
  const [date, setDate] = useState(today);
  const [day, setDay] = useState<ScheduleDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [booking, setBooking] = useState<BookingIntent | null>(null);
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  // Snapshot of "now", taken when the schedule loads, so past-slot styling is pure at render time.
  const [loadedAt, setLoadedAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDay(await endpoints.schedule(date));
      setLoadedAt(Date.now());
    }
    catch { setError("Couldn't load the schedule. Check your connection and press Refresh."); }
    finally { setLoading(false); }
  }, [date]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load(); }, [load]);

  // Reconcile in the BACKGROUND after a write.
  //
  // The page used to await a full-day refetch (and a wallet read) before the member saw
  // anything change, so the cost of a booking was the POST plus two more round trips plus
  // a rebuild of every cell — with the member staring at a grid that still said the slot
  // was free. The write's own response says what happened, so the grid is patched from it
  // immediately and the authoritative read follows behind without being waited on.
  //
  // Silent on failure, deliberately, and this is the one place that is right: the write
  // SUCCEEDED. Telling a member who has just booked and been charged that the schedule
  // could not be loaded would be alarming and untrue, and the patched grid is not wrong,
  // only unconfirmed. Refresh, a date change and the next visit all reload properly.
  const reconcile = useCallback(() => {
    endpoints.schedule(date)
      .then((fresh) => { setDay(fresh); setLoadedAt(Date.now()); })
      .catch(() => { /* the optimistic view stands until something asks for the day again */ });
  }, [date]);

  useEffect(() => {
    if (!isAdmin) return;
    let live = true;
    void fetchMembers().then((rows) => { if (live && rows) setMembers(rows); });
    return () => { live = false; };
  }, [isAdmin]);

  // A booking spends the credit the roster is quoting, so the quote moves with it —
  // otherwise the session's second booking states the balance from before its first.
  const refreshMembers = useCallback(() => {
    void fetchMembers().then((rows) => { if (rows) setMembers(rows); });
  }, []);

  const slotsByCourt = useMemo(() => groupSlotsByCourt(day), [day]);
  const timeSlices = useMemo(() => (day ? buildTimeSlices(day) : []), [day]);

  const dateBounds = useMemo(() => {
    const span = day?.advanceBookingDays ?? 14;
    const back = new Date();
    const forward = new Date();
    // §5 "Date picker lets the player navigate ±N days". `min` was pinned to today for
    // everyone but an admin, so a member could only ever move forward — and with no
    // bookings list anywhere else in the product, there was no way to look at a booking
    // they had already played. Past days are read-only: every slot on them renders as
    // Past and none of them is bookable.
    back.setDate(back.getDate() - span);
    forward.setDate(forward.getDate() + span);
    return { min: isAdmin ? undefined : ymd(back), max: isAdmin ? undefined : ymd(forward) };
  }, [isAdmin, day?.advanceBookingDays]);

  // Keyed on the DAY'S SHAPE, not on `day` — so these two keep their identity while the
  // page's modal state moves, and change only when a new schedule arrives. That is what
  // makes the memo on the grid bite: a callback rebuilt on every render would hand the
  // grid a new prop each time and re-render two hundred cells to open a dialog.
  const timezone = day?.timezone ?? "UTC";
  const sliceMinutes = day?.sliceMinutes ?? 15;

  const openBooking = useCallback(
    (courtId: string, courtName: string, startsAtUtc: string, priceCredits: number) => setBooking({
      courtId, courtName, startsAtUtc, priceCredits,
      whenLabel: formatTime(startsAtUtc, timezone),
      sliceMinutes,
    }), [timezone, sliceMinutes]);

  const openCancel = useCallback((slot: ScheduleSlot, courtName: string) => setCancelling({
    bookingId: slot.bookingId!, courtName,
    whenLabel: formatTime(slot.startsAtUtc, timezone), mine: slot.isMine,
    // First name only — it is all the grid carries, and all it is allowed to.
    memberName: slot.isMine ? null : slot.ownerFirstName,
  }), [timezone]);

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
      // A member who cannot cover the court is not an error to report and dismiss — it is
      // §8's decision, and it goes back to the modal so the admin can take it with the
      // figures in front of them.
      const short = shortfallFrom(err, option, actorUserId);
      if (short) return short;
      // Every other refusal goes back into the dialog too — see `BookingOutcome`. A toast here
      // renders BEHIND the modal, which is the whole of finding J-F3: the member is left with a
      // dialog that did nothing and no reason anywhere they can see. `actorUserId` comes from
      // the other round's work and stays: an admin who picked themselves needs the sentence
      // saying the override cannot reach their own wallet.
      return { kind: "refused", message: refusalText(err, option, actorUserId) };
    }
  };

  // Cancelling a booking and lifting an admin block, both of which end a slot: same optimistic
  // removal, same reconcile, same failure copy. In their own hook because this page was over the
  // 200-line gate and these two are the most self-contained thing in it — see lib/scheduleEnd.ts.
  const { confirmCancel, liftBlock } = useSlotEnders({
    cancelling, setCancelling, setDay, reconcile, refreshBalance, toast,
  });

  return (
    <div className="space-y-4">
      <DayBar
        date={date} bounds={dateBounds} loading={loading}
        onDate={setDate} onRefresh={load}
      />

      {error && <Card><p className="text-sm text-danger-strong">{error}</p></Card>}

      {day && (
        <ScheduleBoard
          day={day}
          slotsByCourt={slotsByCourt}
          timeSlices={timeSlices}
          loadedAt={loadedAt}
          isAdmin={isAdmin}
          onBook={openBooking}
          onCancel={openCancel}
          onLiftBlock={liftBlock}
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
 * The member picker for "book on behalf", carrying each member's balance so §8's four
 * figures — name, balance, price, balance after — are on the dialog before the desk spends
 * somebody else's credit.
 *
 * <p>
 * Admin-only, and it swallows its own failure: a member never asks for it, asking would be
 * a 403 on every schedule visit, and a desk whose roster did not load can still book for
 * itself and cancel. Module-level because it closes over nothing.
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
 * Place the booking and hand back the slot it created, so the grid can show it before
 * the confirming read comes back. The balance comes from the same response — the wallet
 * GET that used to follow every booking was asking a question the POST had answered.
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
    // The MEMBER's balance, and deliberately not handed to applyBalance: the admin's own
    // wallet did not move, and overwriting it with somebody else's figure is the same
    // wrong-wallet mistake in the other direction.
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
 * Narrow on purpose. It fires only on the first attempt of a member-mode booking — an
 * override that is itself refused must not offer another override — and only when the
 * server sent both figures, because the whole value of the offer is that it states what
 * the overdraft will cost the member. Anything else falls through to a toast.
 * </p>
 */
function shortfallFrom(err: unknown, option: AdminOption, actorUserId: string | null): BookingOutcome | null {
  if (option.kind !== "member" || option.allowNegativeBalance) return null;
  // An admin who picked THEMSELVES out of the member list. The server's override is
  // `payer.AllowNegativeBalance && actorId != userId` (BookingService), so this one cannot
  // be granted — an actor authorising their own overdraft is an unlimited credit line, not
  // an override. Offering it here produced a loop with no exit: the modal showed the full
  // §8 offer, the second press was refused, the figures were discarded and the toast said
  // "try again to see what they're short by", which led straight back to the offer.
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
 * `insufficient_balance` reaches this screen for two different people. A member is told to
 * top up, which is what they can do about it. An admin booking on somebody else's behalf
 * was told to top up their own wallet — a desk account with a permanent balance of zero —
 * about a refusal that had nothing to do with it.
 * </p>
 */

function refusalText(err: unknown, option: AdminOption, actorUserId: string | null): string {
  const fallback = "Couldn't make that booking. Refresh the schedule and try again.";
  if (option.kind === "member" && err instanceof ApiError && err.code === "insufficient_balance") {
    // Three audiences, one error code. The admin who picked themselves gets the sentence
    // that says the override does not apply to their own wallet, rather than advice to look
    // again at figures no override can act on.
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
    // Naming the resulting balance is the point of the override being deliberate: the
    // admin who has just put somebody in the red is told by how much, at the moment they
    // did it, rather than by an audit report at month end.
    const owing = memberBalanceAfter !== null && memberBalanceAfter < 0
      ? ` ${memberName}'s balance is now ${formatCredits(memberBalanceAfter)} — they've been emailed about it.`
      : "";
    // Named, not "that member". The desk has just picked a name from a dropdown and
    // spent that person's credit; repeating the name back is the one check that catches
    // a mis-click, and it was the one thing the confirmation refused to do.
    return `Booked ${intent.courtName} at ${intent.whenLabel} for ${memberName}.${owing}`;
  }
  return `Booked ${intent.courtName} at ${intent.whenLabel}.`;
}

function withSlot(day: ScheduleDay | null, slot: ScheduleSlot): ScheduleDay | null {
  return day ? { ...day, slots: [...day.slots, slot] } : day;
}



function formatTime(utc: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", weekday: "short", day: "2-digit", month: "short",
  }).format(new Date(utc));
}
