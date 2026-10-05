import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Panel } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { useBalance } from "../../lib/useBalance";
import { walletTone } from "../../lib/walletTone";
import { BOOKINGS_COPY } from "../../lib/bookingsCopy";
import { firstNameOf } from "../../lib/bookingsApi";
import { BUY_MINUTES_PATH } from "../../lib/minutes";
import { Minutes } from "../Minutes";
import { typography } from "../../lib/typography";
import { cn } from "../../lib/utils";
import type { BookingFor } from "./useBookingFor";

/**
 * What the member can spend, at the top of the Bookings rail (R4 form factor, SPEC 3.1), with the
 * way to buy more — the figure every booking draws on, beside the grid it is spent on. The day's
 * quota stays beside the week strip, at every width: one place each, never
 * two (a copy hidden by CSS is still a second copy to a test and to a stale reader).
 *
 * <p>
 * Nothing until the balance is known: the chip in the bar carries loading and failure.
 * </p>
 *
 * <p>
 * <b>Booking FOR a member (`?as=`), it is THEIR wallet</b> (R5 A5-9): the desk's own "You can
 * spend 0 min — Buy minutes" beside a grid booking for somebody else read as the member's figure.
 * Their spendable, named; no "Buy minutes" (the desk's own shelf would sell to the desk).
 * </p>
 *
 * <p>
 * <b>What is left of today's cap</b> (R5 §3.1, `moreToday`): the pill beside the week says what
 * is USED ("2 of 4 slots today"); the rail says what is LEFT — two facts, one place each.
 * </p>
 */
export function DaySummary(props: { className?: string; bookingFor?: BookingFor | null; moreToday?: number | null }) {
  const { className, bookingFor = null, moreToday = null } = props;
  if (bookingFor) return <MemberSummary className={className} bookingFor={bookingFor} />;
  return <OwnSummary className={className} moreToday={moreToday} />;
}

function OwnSummary({ className, moreToday }: { className?: string; moreToday: number | null }) {
  const { balance, held } = useBalance();
  if (balance === null) return null;
  const spendable = held?.spendable ?? balance;
  const level = walletTone(spendable);
  return (
    <Panel role="group" aria-label={BOOKINGS_COPY.summaryTitle} className={cn("flex flex-col gap-3", className)}>
      <div>
        <p className={typography({ variant: "overline" })}>{BOOKINGS_COPY.summarySpendable}</p>
        <SpendableFigure spendable={spendable} zero={level === "zero"} />
        {moreToday !== null ? <p data-more-today="" className="mt-1 text-sm text-text-secondary">{BOOKINGS_COPY.summaryMoreToday(moreToday)}</p> : null}
      </div>
      <Button asChild variant={level === "zero" ? "primary" : "secondary"} size="sm" className="self-start">
        <Link to={BUY_MINUTES_PATH}>{BOOKINGS_COPY.summaryBuy(level === "zero")}</Link>
      </Button>
    </Panel>
  );
}

/**
 * R13 J13-1 — the spendable figure. Below zero it is 0, with how far under in words beneath it —
 * the Booking-for bar's "can spend 0 minutes — 12 minutes below zero" and the wallet card's
 * `spendableLine` rule. "−12 min" (read "minus 12 minutes") is a debt dressed as spending money.
 */
function SpendableFigure({ spendable, zero }: { spendable: number; zero: boolean }) {
  const under = Math.trunc(spendable) < 0 ? -Math.trunc(spendable) : 0;
  return (
    <>
      <p className={cn("mt-1 font-display text-2xl font-bold", zero && "text-danger-strong")}><Minutes value={Math.max(0, spendable)} /></p>
      {under > 0 ? <p data-below-zero="" className="mt-1 text-sm text-danger-strong">{BOOKINGS_COPY.summaryBelowZero(under)}</p> : null}
    </>
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
        <SpendableFigure spendable={state.member.spendable} zero={level === "zero"} />
      </div>
    </Panel>
  );
}
