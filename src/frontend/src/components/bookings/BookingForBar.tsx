import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserCircle } from "@/components/ui/icons";
import { BOOKING_FOR } from "@/lib/bookingsCopy";
import type { BookingForMember } from "@/lib/bookingsApi";
import type { BookingFor } from "./useBookingFor";

/**
 * F1.6 — `/bookings?as=<member>`, the desk booking for somebody from their page.
 *
 * <p>
 * The page used to look exactly like the admin's own: the admin's balance banner, the club's
 * prices, and nothing saying whose booking this would be until the sheet was open. This bar says
 * it first — who, what they can spend (the figure a booking is checked against, D11 §3a), and
 * what they pay per slice — and offers the way back to booking for oneself.
 * </p>
 */
export function BookingForBar({ booking }: { booking: BookingFor }) {
  const { state, retry } = booking;
  if (state.status === "error") {
    return (
      <div data-booking-for="" className="grid justify-items-start gap-2">
        <Alert tone="warning" className="w-full">{BOOKING_FOR.failed}</Alert>
        <Button variant="outline" size="sm" onClick={retry}>{BOOKING_FOR.retry}</Button>
      </div>
    );
  }
  const member = state.status === "ready" ? state.member : null;
  return (
    <section
      data-booking-for=""
      aria-label={member ? BOOKING_FOR.region(member.name) : BOOKING_FOR.label}
      aria-busy={member ? undefined : true}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-accent-strong/40 bg-accent-soft p-3 sm:p-4"
    >
      <UserCircle size={24} aria-hidden="true" className="shrink-0 text-accent-strong" />
      <div className="grid min-w-0 flex-[1_1_14rem] gap-0.5 text-sm">
        {member ? <MemberFacts member={member} /> : (
          <>
            <span className="sr-only" role="status">{BOOKING_FOR.reading}</span>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-64" />
          </>
        )}
      </div>
      <Link to="/bookings" className="no-lift inline-flex min-h-touch items-center text-sm font-semibold text-accent-strong underline-offset-2 hover:underline">
        {BOOKING_FOR.stop}
      </Link>
    </section>
  );
}

function MemberFacts({ member }: { member: BookingForMember }) {
  // P13 — no price fact: a booking costs its playing minutes, the same for every member.
  const facts = [BOOKING_FOR.canSpend(member.spendable)];
  return (
    <>
      <span className="break-words font-semibold text-text-primary">
        {BOOKING_FOR.label} {member.name}
        {member.groups.length ? <span className="font-normal text-text-secondary">{` · ${member.groups.join(", ")}`}</span> : null}
      </span>
      <span className="text-text-secondary">{facts.join(" · ")}</span>
      {member.reserved > 0 ? <span className="text-xs text-text-secondary">{BOOKING_FOR.held(member.reserved)}</span> : null}
      <span className="text-xs text-text-secondary">{BOOKING_FOR.gridNote}</span>
    </>
  );
}
