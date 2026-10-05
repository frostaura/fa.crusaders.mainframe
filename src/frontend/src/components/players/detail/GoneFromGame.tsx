import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CalendarBlank } from "@/components/ui/icons";
import { StateBlock } from "@/components/ui/state-block";
import { playersEndpoints, type MySeat, type SeatRemovedBy } from "@/lib/playersApi";
import { DETAIL_COPY, DETAIL_GONE, PLAYERS_REFUSAL } from "@/lib/playersCopy";
import { goneSeatWords } from "./goneSeatWords";
import { DetailSkeleton } from "./DetailSkeleton";

/**
 * R5 M5-8 — the booking page answered 404 to a member who WAS on the game: the API says the same to
 * anybody no longer on it (a member taken off, one who declined, pulled out or lapsed). When the
 * link that opened the page names the member's own seat (`?seat=`, the notice "You were taken off
 * Court 4…"), the seat's own record says what became of them — "You were taken off this game" —
 * instead of "Booking not found". Without a seat, or when the seat says nothing of the kind, the
 * page keeps its general sentence.
 */
type GoneSeat = { kind: "reading" } | { kind: "none" } | { kind: "gone"; seat: MySeat };

const GONE = new Set(["removed", "declined", "withdrawn", "lapsed"]);

function useGoneSeat(seatId: string | null, bookingId: string): GoneSeat {
  const [held, setHeld] = useState<{ key: string; found: GoneSeat } | null>(null);
  const key = `${seatId ?? ""}:${bookingId}`;
  useEffect(() => {
    if (!seatId) return undefined;
    let live = true;
    playersEndpoints.mySeat(seatId).then(
      (seat) => {
        const gone = seat.booking_id === bookingId && (GONE.has(seat.status) || seat.lapsed);
        if (live) setHeld({ key, found: gone ? { kind: "gone", seat } : { kind: "none" } });
      },
      // Not this account's seat, or the look failed: say only what is certain.
      () => { if (live) setHeld({ key, found: { kind: "none" } }); },
    );
    return () => { live = false; };
  }, [seatId, bookingId, key]);
  if (!seatId) return { kind: "none" };
  return held?.key === key ? held.found : { kind: "reading" };
}

const BACK = (
  <div className="flex flex-wrap justify-center gap-3">
    <Button asChild variant="outline"><Link to="/bookings">{DETAIL_COPY.backToBookings}</Link></Button>
    <Button asChild variant="outline"><Link to="/wallet">{DETAIL_GONE.wallet}</Link></Button>
  </div>
);

/** The page's 404, said with what became of the member's own seat when the link named it. */
export function NotOnGame({ bookingId, seatId, removedBy = null }: { bookingId: string; seatId: string | null; removedBy?: SeatRemovedBy | null }): ReactNode {
  const found = useGoneSeat(seatId, bookingId);
  if (found.kind === "reading") return <StateBlock loading action={DETAIL_COPY.readAction} skeleton={<DetailSkeleton />} />;
  if (found.kind === "gone") {
    const said = goneSeatWords(found.seat, removedBy);
    return (
      <div data-gone-from-game={found.seat.status}>
        <StateBlock empty emptyIcon={CalendarBlank} emptyTitle={said.title} emptyHint={said.body} emptyAction={BACK} />
      </div>
    );
  }
  return (
    <StateBlock
      empty
      emptyIcon={CalendarBlank}
      emptyTitle={DETAIL_COPY.notFoundTitle}
      emptyHint={PLAYERS_REFUSAL.booking_not_found}
      emptyAction={<Button asChild variant="outline"><Link to="/bookings">{DETAIL_COPY.backToBookings}</Link></Button>}
    />
  );
}
