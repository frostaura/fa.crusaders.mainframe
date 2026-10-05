import { useState } from "react";
import { CancelSheet, type CancelledOutcome } from "@/components/bookings/CancelSheet";
import { gridBookingOf, rereadAsDay } from "@/components/players/detail/gridBooking";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/page-shell";
import { ADMIN_CANCEL } from "@/lib/adminCancelCopy";
import { focusAfterAction } from "@/lib/focusAfterAction";
import type { BookingDetail } from "@/lib/playersApi";

type Props = { detail: BookingDetail; reload: () => void; now?: () => number };

/** The organiser's first name for the sheet's sentences ("Naledi has already checked in…"). */
function firstNameOf(detail: BookingDetail): string | null {
  return detail.organiser.name?.trim().split(/\s+/)[0] || null;
}

/** Whether the organiser's own Cancel is on the page already — the desk's would be a second one. */
function memberCancelShown(detail: BookingDetail): boolean {
  return detail.permissions.can_cancel && !detail.attendance.checked_in_at && detail.viewer.role === "organiser";
}

/**
 * R15 J15-2 — the club cancels a booking from its own page, a STARTED session included.
 *
 * <p>
 * The grid offers a cancel only on future slots, so a session already under way — a court booked
 * in error, a game abandoned for a fault — could not be cancelled from the console at all. This is
 * the grid's own `CancelSheet` on the admin route (`POST /admin/bookings/{id}/cancel`, a reason
 * required): it reads the server's quote and names the outcome before the press — "Naledi has
 * already checked in and the lights have been on, so nothing is refunded" for a session somebody
 * scanned into, the penalty (waivable with a reason) inside the window, every minute back before
 * it. Always the admin route, even on the admin's own booking: the member route refuses a started
 * one, and here the club is acting.
 * </p>
 */
export function AdminCancelPanel({ detail, reload, now = Date.now }: Props) {
  const [open, setOpen] = useState(false);
  if (detail.status !== "booked" || memberCancelShown(detail)) return null;
  const who = detail.organiser.name?.trim() || ADMIN_CANCEL.nobody;
  const started = new Date(detail.starts_at).getTime() <= now();
  const booking = { ...gridBookingOf(detail), mine: false, memberFirstName: firstNameOf(detail) };
  const done = (outcome: CancelledOutcome) => {
    if (outcome.cancelledIds.length === 0) return;
    // The sheet's toast carries the figures; the page re-reads and its cancelled banner takes focus.
    reload();
    focusAfterAction(() => document.querySelector<HTMLElement>("[data-cancelled]"));
  };
  return (
    <Section title={ADMIN_CANCEL.title} description={started ? ADMIN_CANCEL.started(who) : ADMIN_CANCEL.upcoming(who)} data-admin-cancel="">
      <div>
        <Button variant="danger-soft" onClick={() => setOpen(true)}>{ADMIN_CANCEL.open}</Button>
      </div>
      <CancelSheet
        open={open}
        onOpenChange={setOpen}
        bookings={open ? [booking] : []}
        isAdmin
        onCancelled={done}
        onStale={reload}
        reread={() => rereadAsDay(detail.booking_id)}
      />
    </Section>
  );
}
