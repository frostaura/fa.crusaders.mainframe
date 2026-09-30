import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { MAX_SEATS, type PlayerSpec, type PlayersPayload, type SplitMode, type SplitPreviewRequest } from "@/lib/playersApi";
import { BOOK_PLAYERS, firstName, type SentenceSeat } from "@/lib/playersCopy";
import { BOOK_SEATS } from "@/lib/bookingsCopy";
import { parseAmount as parseSharedAmount, type AmountProblem } from "@/lib/amount";
import { hasTwoPlaces, splitShares, type MathResult, type MathSeat } from "./splitMath";

/**
 * The players a member is booking with, before anything is sent — the BookSheet's Players and
 * Split steps hold this, and the booking request, the split preview and the Confirm sentence are
 * all built from it here, so the three can never describe different games.
 *
 * <p>
 * Seats are FIXED positions (2 is your teammate, 3 and 4 the other team) and go out with the
 * request as `seat`, so the court the organiser arranged is the court the server writes. Weights
 * and amounts are held as the text in their fields, so a half-typed "1." is not rounded away
 * under the organiser's thumb; they are parsed when a request is built.
 * </p>
 */

export type DraftSeat = { seat: number; player: PickedPlayer; weight: string; amount: string };

export type PlayersDraft = {
  seats: DraftSeat[];
  mode: SplitMode;
  /** Seat 1's weight in a ratio split. */
  organiserWeight: string;
};

export const EMPTY_DRAFT: PlayersDraft = { seats: [], mode: "equal", organiserWeight: "1" };

/**
 * The free seats in the order a player fills them: an opponent first (seat 3), then the member's
 * partner (2), then the second opponent (4). Singles is the common game, and its one other
 * player is the OPPONENT — seat 2 put them on the member's own side (review round 1, F1.9).
 */
const FILL_ORDER = [3, 2, 4].filter((s) => s <= MAX_SEATS);

/** Seats 1–2 are team A, 3–4 team B. */
export function seatTeam(seat: number): "A" | "B" {
  return seat <= 2 ? "A" : "B";
}

/** "Your side" / "Opponents" — which side of the court a seat is, from the organiser's view. */
export function teamName(seat: number): string {
  return seatTeam(seat) === "A" ? BOOK_SEATS.yourTeam : BOOK_SEATS.otherTeam;
}

export function freeSeats(draft: PlayersDraft): number[] {
  return FILL_ORDER.filter((s) => !draft.seats.some((d) => d.seat === s));
}

/** Puts a player in `seat` when it is free, otherwise the lowest free seat. Unchanged when full. */
export function addPlayer(draft: PlayersDraft, player: PickedPlayer, seat?: number): PlayersDraft {
  const free = freeSeats(draft);
  const target = seat !== undefined && free.includes(seat) ? seat : free[0];
  if (target === undefined) return draft;
  const seats = [...draft.seats, { seat: target, player, weight: "1", amount: "" }].sort((a, b) => a.seat - b.seat);
  return { ...draft, seats };
}

export function removeSeat(draft: PlayersDraft, seat: number): PlayersDraft {
  return { ...draft, seats: draft.seats.filter((s) => s.seat !== seat) };
}

export function updateSeat(draft: PlayersDraft, seat: number, patch: Partial<Pick<DraftSeat, "weight" | "amount">>): PlayersDraft {
  return { ...draft, seats: draft.seats.map((s) => (s.seat === seat ? { ...s, ...patch } : s)) };
}

/** A member or an open link seat — a head who is asked for a share. Guests pay nothing. */
export function isPaying(seat: DraftSeat): boolean {
  return seat.player.kind !== "guest";
}

export function hasPaying(draft: PlayersDraft): boolean {
  return draft.seats.some(isPaying);
}

export function pickedUserIds(draft: PlayersDraft): string[] {
  return draft.seats.flatMap((s) => (s.player.kind === "member" ? [s.player.userId] : []));
}

/** How a seat is named between members: a first name, a guest's name, or "Open seat". */
export function seatName(player: PickedPlayer): string {
  if (player.kind === "member") return firstName(player.name);
  if (player.kind === "guest") return player.name;
  return BOOK_PLAYERS.linkName;
}

/* ─────────────────────────────── the figures ─────────────────────────────── */

/** A whole number 0–100, or null. Blank reads as null, never as 0. */
export function parseWeight(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 100 ? value : null;
}

/**
 * What is wrong with a share typed in credits, or null. Blank is "ask them for nothing" — not a
 * problem. Everything else goes through the product's one amount parser (`lib/amount`): a
 * decimal comma is fine, an exponent is not, and "1,000" is refused as ambiguous.
 */
export function amountProblem(text: string): AmountProblem | null {
  if (text.trim() === "") return null;
  const parsed = parseSharedAmount(text, { decimals: 2, allowZero: true });
  return parsed.ok ? null : parsed.problem;
}

/** Credits ≥ 0 to at most two places, or null. Blank reads as 0 — "ask them for nothing". */
export function parseAmount(text: string): number | null {
  if (text.trim() === "") return 0;
  const parsed = parseSharedAmount(text, { decimals: 2, allowZero: true });
  return parsed.ok && hasTwoPlaces(parsed.value) ? parsed.value : null;
}

type Parsed = { ok: true; organiserWeight: number; seats: MathSeat[] } | { ok: false; error: string };

function parseSeats(draft: PlayersDraft): Parsed {
  const organiserWeight = draft.mode === "ratio" ? parseWeight(draft.organiserWeight) : 1;
  if (organiserWeight === null) return { ok: false, error: "split_weight_invalid" };
  const seats: MathSeat[] = [];
  for (const s of draft.seats) {
    const isGuest = s.player.kind === "guest";
    const weight = draft.mode === "ratio" && !isGuest ? parseWeight(s.weight) : 1;
    if (weight === null) return { ok: false, error: "split_weight_invalid" };
    const amount = draft.mode === "amount" && !isGuest ? parseAmount(s.amount) : 0;
    if (amount === null) return { ok: false, error: "split_amount_invalid" };
    seats.push({ seat: s.seat, isGuest, weight, amount });
  }
  return { ok: true, organiserWeight, seats };
}

/** The split of `price` on the phone — instant validation; the server's preview is what is shown. */
export function localSplit(price: number, draft: PlayersDraft): MathResult {
  const parsed = parseSeats(draft);
  if (!parsed.ok) return parsed;
  return splitShares(price, draft.mode, parsed.organiserWeight, parsed.seats);
}

function specOf(s: DraftSeat, mode: SplitMode): PlayerSpec {
  const who: PlayerSpec =
    s.player.kind === "member" ? { userId: s.player.userId }
      : s.player.kind === "guest" ? { guestName: s.player.name.trim() }
        : { link: true };
  const spec: PlayerSpec = { ...who, seat: s.seat };
  if (s.player.kind === "guest") return spec;
  if (mode === "ratio") spec.weight = parseWeight(s.weight) ?? undefined;
  if (mode === "amount") spec.amount = parseAmount(s.amount) ?? undefined;
  return spec;
}

/**
 * The `players` / `splitMode` / `organiserWeight` a booking is sent with, or null for "just me"
 * — in which case the booking goes by the routes it always did, byte for byte. With guests only
 * there is nothing to split, so the mode is `equal` whatever the Split step last showed.
 */
export function playersPayload(draft: PlayersDraft): PlayersPayload | null {
  if (draft.seats.length === 0) return null;
  const mode = hasPaying(draft) ? draft.mode : "equal";
  const payload: PlayersPayload = { players: draft.seats.map((s) => specOf(s, mode)), splitMode: mode };
  if (mode === "ratio") payload.organiserWeight = parseWeight(draft.organiserWeight) ?? undefined;
  return payload;
}

/** The body of `POST /players/split-preview` for one price. */
export function previewBody(price: number, draft: PlayersDraft): SplitPreviewRequest {
  const payload = playersPayload(draft);
  const body: SplitPreviewRequest = { priceCredits: price, splitMode: payload?.splitMode ?? "equal", players: payload?.players ?? [] };
  if (payload?.organiserWeight !== undefined) body.organiserWeight = payload.organiserWeight;
  return body;
}

/**
 * Switching to Amount with every field blank starts from the equal split — the organiser edits
 * a figure that already adds up rather than four zeroes.
 */
export function withMode(draft: PlayersDraft, mode: SplitMode, price: number | null): PlayersDraft {
  const next = { ...draft, mode };
  if (mode !== "amount" || price === null || draft.seats.some((s) => s.amount.trim() !== "")) return next;
  const equal = localSplit(price, { ...draft, mode: "equal" });
  if (!equal.ok) return next;
  const shareOf = (seat: number) => equal.shares.find((s) => s.seat === seat)?.share ?? 0;
  return {
    ...next,
    seats: draft.seats.map((s) => (isPaying(s) ? { ...s, amount: shareOf(s.seat).toFixed(2) } : s)),
  };
}

/** The seats as the Confirm sentence names them, with each seat's share from `shares`. */
export function sentenceSeats(draft: PlayersDraft, shares: readonly { seat: number; share_credits: number }[]): SentenceSeat[] {
  return draft.seats.map((s) => ({
    kind: s.player.kind === "member" ? "member" : s.player.kind,
    name: seatName(s.player),
    share: shares.find((x) => x.seat === s.seat)?.share_credits ?? 0,
  }));
}
