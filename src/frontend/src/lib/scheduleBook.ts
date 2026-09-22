import { useCallback } from "react";
import { ApiError, endpoints, type ScheduleDay, type ScheduleSlot } from "./api";
import { ADMIN_SELF_SHORT_TEXT, describeBookingError, MEMBER_SHORT_TEXT, provesStaleGrid } from "./bookingErrors";
import { formatCredits } from "./utils";
import type { AdminOption, BookingIntent, BookingOutcome } from "../components/BookingConfirmModal";
import type { MemberOption } from "../pages/Schedule";

/**
 * Confirming one booking — the member's own, the admin's own, an admin's on somebody's behalf,
 * and the admin block.
 *
 * <p>
 * Extracted from `pages/Schedule.tsx` for the reason `lib/scheduleEnd` and `lib/scheduleDay`
 * were: that page carries the schedule's whole state machine, and the complexity gate is what
 * stops it growing without anybody deciding to let it. This is the half that spends money, and
 * having it in a module of its own is also what lets its three refusal paths be read together.
 * </p>
 */

type Args = {
  booking: BookingIntent | null;
  setBooking: (b: BookingIntent | null) => void;
  setDay: React.Dispatch<React.SetStateAction<ScheduleDay | null>>;
  reconcile: () => Promise<void>;
  refreshMembers: () => void;
  applyBalance: (credits: number) => void;
  toast: { push: (t: { tone: "success" | "danger"; text: string }) => void };
  members: MemberOption[];
  /**
   * Who is acting. The member picker lists every active member INCLUDING the admin using it,
   * and §8's override is refused by the server when the actor and the payer are the same
   * person, so the screen has to know which row in that list is the actor's own.
   */
  actorUserId: string | null;
};

export function useBookingConfirm(args: Args) {
  const { booking, setBooking, setDay, reconcile, refreshMembers, applyBalance, toast } = args;
  const { members, actorUserId } = args;
  return useCallback(async (option: AdminOption): Promise<BookingOutcome> => {
    if (!booking) return { kind: "done" };
    try {
      const memberBalanceAfter = await placeBooking(
        booking, option, (slot) => setDay((d) => withSlot(d, slot)), applyBalance);
      toast.push({ tone: "success", text: bookedMessage(booking, option, memberBalanceAfter, nameOf(members, option)) });
      setBooking(null);
      void reconcile();
      if (option.kind === "member") refreshMembers();
      return { kind: "done" };
    } catch (err) {
      // A member who cannot cover the court is not an error to report and dismiss — it is §8's
      // decision, and it goes back to the modal so the admin can take it with the figures in
      // front of them.
      const short = shortfallFrom(err, option, actorUserId);
      if (short) return short;
      // The server has just told us this day is not what we are showing — a slot taken in
      // another browser, a court retired, the club's closing time moved under an open modal.
      if (provesStaleGrid(err)) await reconcile();
      return { kind: "refused", message: refusalText(err, option, actorUserId) };
    }
  }, [booking, setBooking, setDay, reconcile, refreshMembers, applyBalance, toast, members, actorUserId]);
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
