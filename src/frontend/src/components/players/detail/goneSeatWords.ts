import { removedByOf, type MySeat, type SeatRemovedBy } from "@/lib/playersApi";
import { DETAIL_COPY, DETAIL_GONE, playersWhen } from "@/lib/playersCopy";

/**
 * What became of a member's own seat that is off the game, in words — said the same on the
 * booking page's "not on this game" (R5 M5-8) and on the invite mail's link (R16 J15-1, which
 * used to say one sentence for every way off a game).
 *
 * A removal is said as its actor's act (R15 J15-1): the seat's own `removed_by`, else the one the
 * caller read off the booking's 404; neither names nobody — never the organiser. A seat still
 * marked invited or accepted is here only because its window closed: it lapsed.
 */
export function goneSeatWords(seat: MySeat, removedBy: SeatRemovedBy | null = null): { title: string; body: string } {
  const game = DETAIL_GONE.game(seat.court_name ?? DETAIL_COPY.someCourt, playersWhen(seat.starts_at));
  if (seat.status === "removed") {
    const by = removedByOf(seat.removed_by) ?? removedBy;
    return { title: DETAIL_GONE.removedTitle, body: DETAIL_GONE.removedBody(seat.organiser_name ?? DETAIL_GONE.someone, game, by) };
  }
  if (seat.status === "declined") return { title: DETAIL_GONE.leftTitle, body: DETAIL_GONE.declinedBody(game) };
  if (seat.status === "withdrawn") return { title: DETAIL_GONE.leftTitle, body: DETAIL_GONE.withdrawnBody(game) };
  return { title: DETAIL_GONE.leftTitle, body: DETAIL_GONE.lapsedBody(game) };
}
