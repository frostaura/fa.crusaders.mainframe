import { useState } from "react";
import { Alert } from "@/components/Alert";
import { CancelSheet, type CancelledOutcome } from "@/components/bookings/CancelSheet";
import { Button } from "@/components/ui/button";
import { CheckCircle, Clock } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { useBalance } from "@/lib/useBalance";
import { clubClock } from "@/lib/clubClock";
import { focusAfterAction } from "@/lib/focusAfterAction";
import type { BookingDetail } from "@/lib/playersApi";
import { DETAIL_ATTENDANCE, DETAIL_CANCEL, DETAIL_NO_SHOW } from "@/lib/playersCopy";
import { isNoShow, lightsOffAt, liveCount } from "./detailModel";
import { gridBookingOf, rereadAsDay } from "./gridBooking";

/** Checked in or not, and how many of the players have scanned. */
export function Attendance({ detail }: { detail: BookingDetail }) {
  const at = detail.attendance.checked_in_at;
  const players = Math.max(liveCount(detail), 1);
  const dark = lightsOffAt(detail);
  return (
    <Section title={DETAIL_ATTENDANCE.title}>
      <div className="flex flex-col gap-1 rounded-xl border border-border bg-bg-surface p-4 text-sm">
        <p className={at ? "inline-flex items-center gap-2 font-semibold text-success-strong" : "inline-flex items-center gap-2 text-text-secondary"}>
          {/* R12 L12-2 — the line wraps at 320 / 200 %: the icon keeps its size. */}
          {at ? <CheckCircle size={16} weight="bold" aria-hidden="true" className="shrink-0" /> : <Clock size={16} aria-hidden="true" className="shrink-0" />}
          {/* R5 M5-3 — a settled no-show is not waiting for anybody: no "yet". */}
          {at ? DETAIL_ATTENDANCE.checkedInAt(clubClock(at)) : isNoShow(detail) ? DETAIL_NO_SHOW.attendance : DETAIL_ATTENDANCE.notYet}
        </p>
        <p className="text-text-secondary">{DETAIL_ATTENDANCE.count(detail.attendance.players_checked_in, players)}</p>
        {dark ? <p className="text-text-secondary" data-lights-off="">{DETAIL_ATTENDANCE.lightsOffAt(clubClock(dark))}</p> : null}
      </div>
    </Section>
  );
}

type Props = { detail: BookingDetail; reload: () => void };

/**
 * The organiser cancelling: the partners' side said first — their shares come back, and a late
 * penalty is the organiser's alone — then the grid's own sheet with the server's quote.
 */
export function CancelPanel({ detail, reload }: Props) {
  const [open, setOpen] = useState(false);
  const { refresh } = useBalance();
  if (!detail.permissions.can_cancel) return null;
  const done = (outcome: CancelledOutcome) => {
    if (outcome.cancelledIds.length === 0) return;
    // R11 X11-2: the sheet's toast (with the figures) is the one announcement — a page notice as
    // well was the outcome said twice. This panel unmounts with its trigger once the re-read says
    // cancelled, so the keyboard goes to the page's cancelled banner, never `<main>`.
    void refresh({ expectSelf: true });
    reload();
    focusAfterAction(() => document.querySelector<HTMLElement>("[data-cancelled]"));
  };
  return (
    <Section title={DETAIL_CANCEL.title}>
      {detail.money.is_split ? (
        <Alert tone="info" live="off">{`${DETAIL_CANCEL.partnersBack} ${DETAIL_CANCEL.penaltyYours}`}</Alert>
      ) : null}
      <div>
        <Button variant="danger-soft" onClick={() => setOpen(true)}>{DETAIL_CANCEL.open}</Button>
      </div>
      <CancelSheet
        open={open}
        onOpenChange={setOpen}
        bookings={open ? [gridBookingOf(detail)] : []}
        isAdmin={false}
        onCancelled={done}
        onStale={reload}
        reread={() => rereadAsDay(detail.booking_id)}
      />
    </Section>
  );
}
