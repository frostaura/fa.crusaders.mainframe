import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Panel } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { useBalance, walletTone } from "../../lib/balance";
import { BOOKINGS_COPY } from "../../lib/bookingsCopy";
import { firstNameOf } from "../../lib/bookingsApi";
import { TOP_UP_LABEL } from "../../lib/walletCopy";
import { typography } from "../../lib/typography";
import { cn, formatCredits } from "../../lib/utils";
import type { BookingFor } from "./useBookingFor";

/**
 * What the member can spend, at the top of the Bookings rail (R4 form factor, SPEC 3.1), with the
 * way to top up — the figure every booking draws on, beside the grid it is spent on. The day's
 * quota and the member's rate stay beside the week strip, at every width: one place each, never
 * two (a copy hidden by CSS is still a second copy to a test and to a stale reader).
 *
 * <p>
 * Nothing until the balance is known: the chip in the bar carries loading and failure.
 * </p>
 *
 * <p>
 * <b>Booking FOR a member (`?as=`), it is THEIR wallet</b> (R5 A5-9): the desk's own "You can
 * spend 0.00 cr — Top up" beside a grid booking for somebody else read as the member's figure.
 * Their spendable, named; no Top up (the desk's own top-up page would credit the desk).
 * </p>
 */
export function DaySummary({ className, bookingFor = null }: { className?: string; bookingFor?: BookingFor | null }) {
  if (bookingFor) return <MemberSummary className={className} bookingFor={bookingFor} />;
  return <OwnSummary className={className} />;
}

function OwnSummary({ className }: { className?: string }) {
  const { balance, held } = useBalance();
  if (balance === null) return null;
  const spendable = held?.spendable ?? balance;
  const level = walletTone(spendable);
  return (
    <Panel role="group" aria-label={BOOKINGS_COPY.summaryTitle} className={cn("flex flex-col gap-3", className)}>
      <div>
        <p className={typography({ variant: "overline" })}>{BOOKINGS_COPY.summarySpendable}</p>
        <p className={cn("mt-1 font-display text-2xl font-bold tabular-nums", level === "zero" && "text-danger-strong")}>{formatCredits(spendable)}</p>
      </div>
      <Button asChild variant={level === "zero" ? "primary" : "secondary"} size="sm" className="self-start">
        <Link to="/wallet/topup">{TOP_UP_LABEL[level]}</Link>
      </Button>
    </Panel>
  );
}

function MemberSummary({ className, bookingFor }: { className?: string; bookingFor: BookingFor }) {
  const { state } = bookingFor;
  // A failed read is said (with its retry) by the Booking-for bar above the grid.
  if (state.status === "error") return null;
  if (state.status === "loading") {
    return (
      <Panel aria-busy="true" className={cn("flex flex-col gap-2", className)}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-32" />
      </Panel>
    );
  }
  const name = firstNameOf(state.member.name);
  const level = walletTone(state.member.spendable);
  return (
    <Panel role="group" aria-label={BOOKINGS_COPY.summaryTheirTitle(name)} className={cn("flex flex-col gap-3", className)}>
      <div>
        <p className={typography({ variant: "overline" })}>{BOOKINGS_COPY.summaryTheirSpendable(name)}</p>
        <p className={cn("mt-1 font-display text-2xl font-bold tabular-nums", level === "zero" && "text-danger-strong")}>
          {formatCredits(state.member.spendable)}
        </p>
      </div>
    </Panel>
  );
}
