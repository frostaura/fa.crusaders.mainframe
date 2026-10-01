import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { parseAmount, parseWeight, type DraftSeat, type PlayersDraft } from "@/components/bookings/playersDraft";
// `parseAmount` above reads the Split step's own draft fields (the BookSheet's rule); a figure
// typed into the share ask goes through the shared money parser instead.
import { parseMinutesAmount } from "@/lib/amount";
import { amountProblemSentence } from "@/lib/amountCopy";
import type { BookingDetail, DetailPlayer, PlayerSpec, SplitChange, SplitPreviewShare } from "@/lib/playersApi";
import { CHANGE_SPLIT, PLAYERS_REFUSAL } from "@/lib/playersCopy";
import { minutesCompact } from "@/lib/minutes";
import { isLive, seatName } from "./detailModel";

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
    seat: p.seat, player: pickedOf(p), weight: String(p.weight), amount: String(p.share_minutes),
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

/**
 * R2 F2-3 — what saving a new split does to a booking that already stands, seat by seat: who is
 * asked for (more), what goes back to whom, and what the organiser covers in the end. The
 * booking-time "you pay now · you get back as they accept" is wrong here: the court is paid for
 * and some partners have paid their part.
 */
export function splitEffects(d: BookingDetail, shares: readonly SplitPreviewShare[]): string[] {
  const lines: string[] = [];
  for (const p of partnerSeats(d)) {
    if (p.kind === "guest") continue;
    const next = shares.find((s) => s.seat === p.seat)?.share_minutes;
    if (next === undefined) continue;
    const name = seatName(p, d.players);
    if (p.status !== "accepted") {
      if (next !== p.share_minutes) lines.push(CHANGE_SPLIT.askedFor(name, minutesCompact(next)));
    } else if (next > p.paid_minutes) {
      if (next !== p.share_minutes || p.unpaid_minutes > 0) {
        lines.push(CHANGE_SPLIT.askedMore(name, minutesCompact(next - p.paid_minutes), next > p.consented_minutes));
      }
    } else if (next < p.paid_minutes) {
      lines.push(CHANGE_SPLIT.goesBack(name, minutesCompact(p.paid_minutes - next)));
    }
  }
  if (lines.length === 0) return [CHANGE_SPLIT.noChange];
  const organiser = shares.find((s) => s.seat === 1);
  if (organiser) lines.push(CHANGE_SPLIT.youCover(minutesCompact(organiser.share_minutes)));
  return lines;
}

/* ─────────────────────────────── a share for a player added later ─────────────────────────────── */

/** Whether adding this pick to this booking needs a figure: a paying seat on an amount or ratio split. */
export function needsShareAsk(d: BookingDetail, pick: PickedPlayer): boolean {
  if (pick.kind === "guest") return false;
  return d.split_mode === "amount" || d.split_mode === "ratio";
}

/** What the organiser covers now — the most an added seat can be asked for under an amount split. */
export function organiserShare(d: BookingDetail): number {
  const own = d.players.find((p) => p.kind === "organiser")?.share_minutes ?? d.money.price_minutes;
  if (d.split_mode !== "amount") return own;
  // R4 M4-6 — an amount split's organiser covers what the live partner seats are NOT asked for.
  // Derived here, not read off the organiser's seat: that figure went stale after a removal
  // ("You cover 30 min now" beside a Money panel saying 50) and capped the ask with it.
  const asked = partnerSeats(d).reduce((sum, p) => sum + p.share_minutes, 0);
  return Math.max(0, d.money.price_minutes - asked);
}

/**
 * The figure the ask starts from: an amount split offers the equal share of the price among the
 * payers after the add, in whole minutes, capped by what the organiser covers now; a ratio split
 * offers weight 1.
 */
export function defaultAsk(d: BookingDetail): string {
  if (d.split_mode === "ratio") return "1";
  const payers = partnerSeats(d).filter((p) => p.kind !== "guest").length + 2;
  const equal = Math.floor(d.money.price_minutes / payers);
  return String(Math.max(0, Math.min(equal, organiserShare(d))));
}

/**
 * The figure typed, as a spec's `weight` / `amount`, or the sentence saying why not. An amount
 * goes through the club's ONE amount parser (`lib/amount`, F3.18) with the minutes rules: whole
 * minutes only ("22,5" is refused as too precise, never rounded), "1e3" and "1,000" are refused
 * with their own reasons, and 0 is allowed — it means the organiser covers them.
 */
export function askedFigure(d: BookingDetail, text: string): { ok: true; spec: Pick<PlayerSpec, "weight" | "amount"> } | { ok: false; error: string } {
  if (d.split_mode === "ratio") {
    const weight = parseWeight(text);
    return weight === null ? { ok: false, error: PLAYERS_REFUSAL.split_weight_invalid } : { ok: true, spec: { weight } };
  }
  const parsed = parseMinutesAmount(text, { allowZero: true });
  if (!parsed.ok) return { ok: false, error: amountProblemSentence(parsed.problem, "minutes") };
  if (parsed.value > organiserShare(d)) return { ok: false, error: PLAYERS_REFUSAL.split_exceeds_price };
  return { ok: true, spec: { amount: parsed.value } };
}
