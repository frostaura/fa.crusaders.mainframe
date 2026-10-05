import { minutesSpoken } from "@/lib/minutes";
import type { BookingDetail } from "@/lib/playersApi";
import { firstName } from "@/lib/playersNames";

/**
 * R16 J16-7 — the partners' shares that stand when the club cancels a started session: accepted
 * member partners (never the organiser) who paid more than nothing and did not settle by hand, as
 * "Owen's 15 minutes". One rule for the admin cancel panel and the cancel sheet.
 */
export function standingShares(detail: BookingDetail): string[] {
  return detail.players
    .filter((p) => p.kind === "member" && p.user_id !== detail.organiser.user_id && p.status === "accepted" && !p.settled_outside && p.paid_minutes > 0)
    .map((p) => `${firstName(p.name ?? "")}'s ${minutesSpoken(p.paid_minutes)}`);
}
