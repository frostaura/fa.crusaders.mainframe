import { formatCredits } from "../lib/utils";
import type { BookingIntent } from "./BookingConfirmModal";

/**
 * The parts of the booking confirmation that only READ — the six figures, the balances,
 * a refusal and §8's overdraft panel.
 *
 * <p>
 * A separate module for the reason `ScheduleCells.tsx` is one: lizard's .tsx parser loses
 * track inside a JSX fragment and attributes the whole remainder of a file to the component
 * above it, so a long file trips `make complexity`'s length gate on a function nobody
 * touched. Splitting the reading half from the deciding half keeps both files short enough
 * for that to stay untrue, and the seam is a real one either way.
 * </p>
 */

/**
 * §5's six figures: court, time, duration, cost, current balance, balance after.
 *
 * <p>
 * Split out of the modal rather than inlined because it is the only part of the dialog
 * that does not move — the admin controls, the refusal and the actions all react to what
 * the desk is doing, and this states the slot.
 * </p>
 */
export function CostSummary(props: {
  intent: BookingIntent; balanceCredits: number | null; memberBalance: number | null;
  free: boolean; cost: number; chargedToSomeoneElse: boolean;
}) {
  const { intent, balanceCredits, memberBalance, free, cost, chargedToSomeoneElse } = props;
  const wallet = chargedToSomeoneElse ? memberBalance : balanceCredits;
  return (
    <dl className="text-sm space-y-1.5 mb-4">
      <Row term="Court" value={intent.courtName} />
      <Row term="Time" value={intent.whenLabel} />
      <Row term="Duration" value={`${intent.sliceMinutes} min`} />
      <Row term="Cost" value={free ? "No charge — court held, not sold" : formatCredits(cost)} />
      {!free && <BalanceRows wallet={wallet} cost={cost} theirs={chargedToSomeoneElse} />}
    </dl>
  );
}

/**
 * The two balance figures, addressed to whichever wallet is actually paying.
 *
 * <p>
 * "Their balance: charged to the member" was the whole of what an admin saw — a phrase
 * where a number belongs, and no "balance after" row at all. The desk could see the price
 * and the court but not whose credit it was spending or what it left them, which is the
 * one check that catches a wrong name picked from a dropdown. It is stated as the club
 * last read it, and the server still decides: a member who turns out to be short is
 * refused, and §8's override panel restates both figures from the refusal itself.
 * </p>
 */
export function BalanceRows({ wallet, cost, theirs }: { wallet: number | null; cost: number; theirs: boolean }) {
  if (wallet !== null) {
    return (
      <>
        <Row term={theirs ? "Their balance" : "Balance now"} value={formatCredits(wallet)} />
        <Row term={theirs ? "Their balance after" : "Balance after"} value={formatCredits(wallet - cost)} emphasise />
      </>
    );
  }
  if (!theirs) return null;
  return (
    <Row term="Their balance" value="Choose a member to see it" />
  );
}

/**
 * A refusal, in the dialog that caused it.
 *
 * <p>
 * `role="alert"` because the button has just returned to rest and looks untouched: without
 * an announcement a screen-reader user has no signal that anything happened at all. It is
 * a sentence, never a code and never an exception — `lib/bookingErrors.ts` owns the
 * mapping.
 * </p>
 */
export function Refusal({ message }: { message: string }) {
  return (
    <p role="alert" className="mb-3 rounded-lg border border-danger-soft bg-danger-soft/40 p-3 text-sm text-danger-strong">
      {message}
    </p>
  );
}

/**
 * §8: "Book on behalf of any member (charges that member's credit; if insufficient, admin
 * can override and create a negative balance, logged)."
 *
 * <p>
 * The override is a second, deliberate step and this is what makes it one. The desk sends
 * an ordinary booking, the server refuses it with the member's balance and the price, and
 * only then does an override appear — labelled with the balance it will leave behind, in a
 * danger button, beside the member's own name. An admin who picked the wrong person from
 * the dropdown finds out here, from the name and the figures, rather than from an audit
 * report at month end.
 * </p>
 *
 * <p>
 * The dialog already shows the member's balance from the club's own roster, but these
 * figures are re-stated from the REFUSAL rather than reused from it: the numbers that
 * decide an overdraft are the ones the server refused on, under the lock that decides the
 * booking, and a roster figure read when the page loaded can be stale by the time the desk
 * presses the button.
 * </p>
 */
export function OverdraftNotice({ name, current, required }: { name: string; current: number; required: number }) {
  return (
    <div className="mb-3 rounded-lg border border-danger-soft bg-danger-soft/40 p-3 text-sm">
      <p className="font-semibold text-danger-strong">
        {name} doesn't have enough credit for this court.
      </p>
      <dl className="mt-2 space-y-1">
        <Row term="Their balance" value={formatCredits(current)} />
        <Row term="This booking" value={formatCredits(required)} />
        <Row term="Their balance after" value={formatCredits(current - required)} emphasise />
      </dl>
      <p className="mt-2 text-text-secondary">
        You can book it anyway. It charges {name} the full price, leaves them owing the
        difference, and is logged against your name. They'll be emailed and asked to top up.
      </p>
    </div>
  );
}

export function Row({ term, value, emphasise }: { term: string; value: string; emphasise?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-secondary">{term}</dt>
      <dd className={emphasise ? "font-semibold text-text-primary" : "text-text-primary"}>{value}</dd>
    </div>
  );
}
