import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { parseAmount, parseWeight, type DraftSeat, type PlayersDraft } from "@/components/bookings/playersDraft";
import type { BookingDetail, DetailPlayer, PlayerSpec, SplitChange } from "@/lib/playersApi";
import { isLive } from "./detailModel";

/**
 * R1 F2.1 — changing the split of a booking that already stands, and asking a share of a player
 * added to it. Pure: the booking page's Change split dialog edits a `PlayersDraft` — the
 * BookSheet's own shape, so its Split step is reused as it is — built from the live seats here,
 * and the `PUT /bookings/{id}/split` body is read back off it.
 */

function pickedOf(p: DetailPlayer): PickedPlayer {
  if (p.kind === "guest") return { kind: "guest", name: (p.name ?? "").trim() };
  if (p.kind === "open_link") return { kind: "link" };
  return { kind: "member", userId: p.user_id ?? "", name: p.name ?? "", photoUrl: p.photo_url };
}

/** The live partner seats (2–4), in seat order. */
function partnerSeats(d: BookingDetail): DetailPlayer[] {
  return d.players.filter((p) => isLive(p) && p.kind !== "organiser").sort((a, b) => a.seat - b.seat);
}

/** The booking's split as it stands, as a draft the Split step can edit. */
export function draftOf(d: BookingDetail): PlayersDraft {
  const organiser = d.players.find((p) => p.kind === "organiser");
  const seats: DraftSeat[] = partnerSeats(d).map((p) => ({
    seat: p.seat, player: pickedOf(p), weight: String(p.weight), amount: p.share_credits.toFixed(2),
  }));
  return { seats, mode: d.split_mode, organiserWeight: String(organiser?.weight ?? 1) };
}

/**
 * The body of `PUT /bookings/{id}/split`, or null while a figure cannot be read. Seats go by
 * participant id; a guest carries no figure (it plays free whatever the mode), and the organiser
 * is named only for a ratio split, where its weight counts — it always takes the remainder.
 */
export function splitChangeOf(d: BookingDetail, draft: PlayersDraft): SplitChange | null {
  const seats: SplitChange["seats"] = [];
  const organiser = d.players.find((p) => p.kind === "organiser");
  if (draft.mode === "ratio" && organiser?.participant_id) {
    const weight = parseWeight(draft.organiserWeight);
    if (weight === null) return null;
    seats.push({ participantId: organiser.participant_id, weight });
  }
  for (const p of partnerSeats(d)) {
    const edited = draft.seats.find((s) => s.seat === p.seat);
    if (!edited || !p.participant_id || p.kind === "guest") continue;
    if (draft.mode === "ratio") {
      const weight = parseWeight(edited.weight);
      if (weight === null) return null;
      seats.push({ participantId: p.participant_id, weight });
    } else if (draft.mode === "amount") {
      const amount = parseAmount(edited.amount);
      if (amount === null) return null;
      seats.push({ participantId: p.participant_id, amount });
    } else {
      seats.push({ participantId: p.participant_id });
    }
  }
  return { mode: draft.mode, seats };
}

/* ─────────────────────────────── a share for a player added later ─────────────────────────────── */

/** Whether adding this pick to this booking needs a figure: a paying seat on an amount or ratio split. */
export function needsShareAsk(d: BookingDetail, pick: PickedPlayer): boolean {
  if (pick.kind === "guest") return false;
  return d.split_mode === "amount" || d.split_mode === "ratio";
}

/** What the organiser covers now — the most an added seat can be asked for under an amount split. */
export function organiserShare(d: BookingDetail): number {
  return d.players.find((p) => p.kind === "organiser")?.share_credits ?? d.money.price_credits;
}

/**
 * The figure the ask starts from: an amount split offers the equal share of the price among the
 * payers after the add, in whole credits, capped by what the organiser covers now; a ratio split
 * offers weight 1.
 */
export function defaultAsk(d: BookingDetail): string {
  if (d.split_mode === "ratio") return "1";
  const payers = partnerSeats(d).filter((p) => p.kind !== "guest").length + 2;
  const equal = Math.floor(d.money.price_credits / payers);
  return Math.max(0, Math.min(equal, Math.floor(organiserShare(d)))).toFixed(2);
}

/** The figure typed, as a spec's `weight` / `amount`, or a refusal code the sentence map knows. */
export function askedFigure(d: BookingDetail, text: string): { ok: true; spec: Pick<PlayerSpec, "weight" | "amount"> } | { ok: false; error: string } {
  if (d.split_mode === "ratio") {
    const weight = parseWeight(text);
    return weight === null ? { ok: false, error: "split_weight_invalid" } : { ok: true, spec: { weight } };
  }
  const amount = parseAmount(text);
  if (amount === null) return { ok: false, error: "split_amount_invalid" };
  if (amount > organiserShare(d)) return { ok: false, error: "split_exceeds_price" };
  return { ok: true, spec: { amount } };
}
