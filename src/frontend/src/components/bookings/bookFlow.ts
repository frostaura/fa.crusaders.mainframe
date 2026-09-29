import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  endpoints,
  type AdminBookingQuote,
  type AdminBulkQuote,
  type BulkBookItemBody,
  type BulkBookResponse,
  type MemberBulkBookResponse,
} from "@/lib/api";
import { formatMinutes } from "@/lib/utils";
import { clubClock } from "@/lib/clubClock";
import { refusalReason, RESULT_WORD } from "@/lib/bookingsCopy";
import { playersEndpoints, type PlayersPayload } from "@/lib/playersApi";
import type { SelectedSlot } from "./types";
import type { BulkResultRow } from "./BulkResults";
import { fromBulkWithPlayers, fromSingleWithPlayers, type PlayersOutcome } from "./playersOutcome";

/**
 * Everything BookSheet decides that is not drawing: the steps, the admin quote, the call that
 * books, and the answer turned into rows. Kept out of the component so the component stays a
 * layout (and under the complexity gate), and so the money rules can be read in one place.
 */

/* ─────────────────────────────── who ─────────────────────────────── */

/** An admin's "Book as". A member is always `self` and never sees the choice. */
export type BookAs =
  | { kind: "self" }
  | { kind: "member"; userId: string | null }
  | { kind: "hold"; label: string };

/** What the choice is missing, if anything — shown under the field, never as a dead button. */
export function whoProblem(who: BookAs): "member" | "hold" | null {
  if (who.kind === "member" && !who.userId) return "member";
  if (who.kind === "hold" && who.label.trim() === "") return "hold";
  return null;
}

/* ─────────────────────────────── steps ─────────────────────────────── */

/**
 * The stepper. Order is fixed; each step says whether it applies to THIS sheet.
 *
 * <p>
 * <b>P11 (D11).</b> A MEMBER picks their players, then — only when somebody is being asked for a
 * share (a member or an open link seat; a guest pays nothing and is not a head) — how to split
 * the cost. An ADMIN keeps Slots → Confirm: "Book as" is their decision, and players are added
 * afterwards from the booking's own page, where the desk's god-mode add lives.
 * </p>
 */
export type StepId = "slots" | "players" | "split" | "confirm";

type StepContext = {
  isAdmin: boolean;
  /** Somebody on the booking is asked for a share. */
  paying?: boolean;
};

const STEP_ORDER: readonly StepId[] = ["slots", "players", "split", "confirm"];

const APPLIES: Record<StepId, (ctx: StepContext) => boolean> = {
  // The only decision on it is the admin's "Book as"; a member's slots are listed on Confirm.
  slots: (ctx) => ctx.isAdmin,
  players: (ctx) => !ctx.isAdmin,
  split: (ctx) => !ctx.isAdmin && Boolean(ctx.paying),
  confirm: () => true,
};

export function stepsFor(ctx: StepContext): StepId[] {
  return STEP_ORDER.filter((id) => APPLIES[id](ctx));
}

/* ─────────────────────────────── slot faces ─────────────────────────────── */

/**
 * "Tue 23 Sep" in the club's zone. Built from parts because ICU's en-GB spells September
 * "Sept" — the one four-letter month, which would make this the one label that does not match
 * the week strip and the grid.
 */
export function clubDayLabel(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: timezone })
    .formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month").slice(0, 3)}`;
}

/** "Tue 23 Sep", "18:00–18:45", "45 min" — the club's clock, whatever the reader's locale. */
export function slotFace(slot: SelectedSlot, timezone: string, sliceMinutes: number) {
  const start = new Date(slot.startsAt);
  const minutes = slot.sliceCount * sliceMinutes;
  const end = new Date(start.getTime() + minutes * 60_000);
  const day = clubDayLabel(start, timezone);
  return {
    day,
    time: `${clubClock(start, timezone)}–${clubClock(end, timezone)}`,
    duration: formatMinutes(minutes),
  };
}

export function slotKey(slot: Pick<SelectedSlot, "courtId" | "startsAt">): string {
  return `${slot.courtId}@${slot.startsAt}`;
}

/**
 * How many grid slots a set of bookings covers. The sheet counts in the grid's unit, not in
 * requests: three ticked slots of which two are adjacent on one court go out as two bookings, and
 * a sheet titled "Book 2 slots" under a bar that said "3 slots · 150.00 cr" reads as a slot lost.
 */
export function slotCount(slots: readonly Pick<SelectedSlot, "sliceCount">[]): number {
  return slots.reduce((n, s) => n + Math.max(1, s.sliceCount), 0);
}

export function itemsOf(slots: readonly SelectedSlot[]): BulkBookItemBody[] {
  return slots.map((s) => ({ courtId: s.courtId, startsAt: s.startsAt, sliceCount: s.sliceCount }));
}

export function newIdempotencyKey(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

/* ─────────────────────────────── the quote (admin, R19) ─────────────────────────────── */

/**
 * Both quote routes, in one shape. `prices` is the PAYER's price per item (group pricing makes
 * it differ from the grid's, which is the viewer's); `refused` maps an item index to its refusal
 * code. `total` counts bookable items only, as the server sums it.
 */
export type SheetQuote = {
  total: number;
  balance: number;
  after: number;
  overdraws: boolean;
  /** P11 — what the payer owes back to partners (0 against an older API). */
  owedBack: number;
  prices: Map<number, number>;
  refused: Map<number, string | null>;
};

function owedBackOf(q: { owed_back_credits?: number }): number {
  return typeof q.owed_back_credits === "number" && q.owed_back_credits > 0 ? q.owed_back_credits : 0;
}

function fromSingle(q: AdminBookingQuote): SheetQuote {
  return {
    total: q.price_credits, balance: q.balance_credits, after: q.balance_after_credits,
    overdraws: q.overdraws, owedBack: owedBackOf(q), prices: new Map([[0, q.price_credits]]), refused: new Map(),
  };
}

function fromBulk(q: AdminBulkQuote): SheetQuote {
  const refused = new Map<number, string | null>();
  const prices = new Map<number, number>();
  for (const item of q.items ?? []) {
    if (!item.bookable) refused.set(item.index, item.reason);
    else if (typeof item.price_credits === "number") prices.set(item.index, item.price_credits);
  }
  return {
    total: q.total_credits, balance: q.balance_credits, after: q.balance_after_credits,
    overdraws: q.overdraws, owedBack: owedBackOf(q), prices, refused,
  };
}

async function readQuote(slots: readonly SelectedSlot[], payerId: string | undefined): Promise<SheetQuote> {
  if (slots.length === 1) {
    const [s] = slots;
    return fromSingle(await endpoints.adminBookingQuote({
      userId: payerId, courtId: s.courtId, startsAt: s.startsAt, slices: s.sliceCount,
    }));
  }
  return fromBulk(await endpoints.adminBulkBookingQuote({ userId: payerId, items: itemsOf(slots) }));
}

export type QuoteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; quote: SheetQuote }
  | { status: "error"; error: unknown };

/**
 * The admin's quote, read when the Confirm step is reached for a paying choice. Never for a
 * member (members never overdraw and pay the price the grid showed them) and never for a hold
 * (nobody pays). `attempt` re-reads it after a failure.
 */
export function useAdminQuote(slots: readonly SelectedSlot[], who: BookAs, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const paying = who.kind === "self" || (who.kind === "member" && Boolean(who.userId));
  const payerId = who.kind === "member" ? who.userId ?? undefined : undefined;
  // Keyed on what the slots ARE, not on the array's identity: a parent that rebuilds the array
  // on every render must not re-read the quote on every render. The state is DERIVED from
  // whether the answer on hand is the answer to this key — no "loading" is ever set by hand.
  const latest = useRef(slots);
  useLayoutEffect(() => { latest.current = slots; });
  const slotsKey = slots.map((s) => `${slotKey(s)}x${s.sliceCount}`).join("|");
  const requestKey = enabled && paying ? `${slotsKey}#${payerId ?? "self"}#${attempt}` : null;

  useEffect(() => {
    if (!requestKey) return undefined;
    let live = true;
    readQuote(latest.current, payerId).then(
      (quote) => { if (live) setAnswer({ key: requestKey, ok: true, quote }); },
      (error: unknown) => { if (live) setAnswer({ key: requestKey, ok: false, error }); },
    );
    return () => { live = false; };
  }, [requestKey, payerId]);

  return { state: stateOf(requestKey, answer), retry: () => setAttempt((n) => n + 1) };
}

type Answer =
  | { key: string; ok: true; quote: SheetQuote }
  | { key: string; ok: false; error: unknown };

function stateOf(requestKey: string | null, answer: Answer | null): QuoteState {
  if (!requestKey) return { status: "idle" };
  if (!answer || answer.key !== requestKey) return { status: "loading" };
  return answer.ok ? { status: "ready", quote: answer.quote } : { status: "error", error: answer.error };
}

/* ─────────────────────────────── the answer, as rows ─────────────────────────────── */

/** One item's outcome, as `BulkResults` draws it. */
export type ResultRow = BulkResultRow;

export type BookRun = {
  rows: ResultRow[];
  booked: SelectedSlot[];
  /** The PAYER's balance after, when known. */
  balanceAfter: number | null;
  /** `insufficient_balance` when the batch stopped part-way. */
  halted: string | null;
  hold: boolean;
  /** Set when the booking went out with players: the links to share, per booking. */
  players?: PlayersOutcome | null;
};

type Face = (slot: SelectedSlot) => string;

function row(slot: SelectedSlot, face: Face, ok: boolean, word: string, detail: string | null): ResultRow {
  return { key: slotKey(slot), courtName: slot.courtName, when: face(slot), ok, word, detail };
}

function singleRun(slot: SelectedSlot, face: Face, balanceAfter: number | null, hold: boolean): BookRun {
  return {
    rows: [row(slot, face, true, hold ? RESULT_WORD.held : RESULT_WORD.booked, null)],
    booked: [slot], balanceAfter, halted: null, hold,
  };
}

export function fromMemberBulk(res: MemberBulkBookResponse, sent: readonly SelectedSlot[], face: Face): BookRun {
  const rows: ResultRow[] = [];
  const booked: SelectedSlot[] = [];
  for (const r of res.results ?? []) {
    const slot = sent[r.index];
    if (!slot) continue;
    const ok = r.status === "booked";
    if (ok) booked.push(slot);
    const word = ok ? (r.replayed ? RESULT_WORD.replayed : RESULT_WORD.booked) : RESULT_WORD.refused;
    rows.push(row(slot, face, ok, word, ok ? null : refusalReason(r.reason)));
  }
  return { rows, booked, balanceAfter: res.balance_after_credits ?? null, halted: res.halted_reason ?? null, hold: false };
}

const ADMIN_OK: Record<string, string> = {
  booked: RESULT_WORD.booked, blocked: RESULT_WORD.held, duplicate: RESULT_WORD.replayed,
};

export function fromAdminBulk(res: BulkBookResponse, sent: readonly SelectedSlot[], face: Face, hold: boolean): BookRun {
  const rows: ResultRow[] = [];
  const booked: SelectedSlot[] = [];
  (res.results ?? []).forEach((raw, i) => {
    const index = typeof raw.index === "number" ? raw.index : i;
    const slot = sent[index];
    if (!slot) return;
    const status = typeof raw.status === "string" ? raw.status : "failed";
    const word = ADMIN_OK[status];
    if (word) booked.push(slot);
    const code = typeof raw.error === "string" ? raw.error : null;
    rows.push(row(slot, face, Boolean(word), word ?? RESULT_WORD.refused, word ? null : refusalReason(code)));
  });
  const after = res.payer?.balance_after_credits;
  return {
    rows, booked, balanceAfter: typeof after === "number" ? after : null,
    halted: typeof res.halted_reason === "string" ? res.halted_reason : null, hold,
  };
}

/* ─────────────────────────────── the call ─────────────────────────────── */

export type BookRequest = {
  slots: readonly SelectedSlot[];
  who: BookAs;
  isAdmin: boolean;
  actorUserId: string | null;
  idempotencyKey: string;
  /** God mode (R19): sent when the quote said `overdraws`, or on "Book the rest anyway". */
  allowNegativeBalance: boolean;
  face: Face;
  /** A member's players (D11). Null or absent: the routes a booking always took, unchanged. */
  players?: PlayersPayload | null;
};

/**
 * With players, the same two routes carry the players payload. The bulk one is all-or-nothing on
 * the players: a split that cannot work on any item is refused before anything is booked, so the
 * refusal reaches the sheet as a failure (it stays on Confirm) rather than as rows.
 */
async function bookWithPlayers(req: BookRequest, players: PlayersPayload): Promise<BookRun> {
  const { slots, face } = req;
  if (slots.length === 1) {
    const [s] = slots;
    const r = await playersEndpoints.bookWithPlayers({ courtId: s.courtId, startsAt: s.startsAt, sliceCount: s.sliceCount, ...players });
    return { ...singleRun(s, face, r.balance_after_credits, false), players: fromSingleWithPlayers(r, s) };
  }
  const res = await playersEndpoints.bulkWithPlayers({ idempotencyKey: req.idempotencyKey, items: itemsOf(slots), ...players });
  return { ...fromMemberBulk(res, slots, face), players: fromBulkWithPlayers(res, slots) };
}

async function bookAsMember(req: BookRequest): Promise<BookRun> {
  const { slots, face } = req;
  if (req.players) return bookWithPlayers(req, req.players);
  if (slots.length === 1) {
    const [s] = slots;
    const r = await endpoints.book(s.courtId, s.startsAt, s.sliceCount);
    return singleRun(s, face, r.balance_after_credits, false);
  }
  const res = await endpoints.memberBulkBook({ idempotencyKey: req.idempotencyKey, items: itemsOf(slots) });
  return fromMemberBulk(res, slots, face);
}

async function holdAsAdmin(req: BookRequest, label: string): Promise<BookRun> {
  const { slots, face } = req;
  if (slots.length === 1) {
    const [s] = slots;
    await endpoints.adminBlock(s.courtId, s.startsAt, s.sliceCount, label);
    return singleRun(s, face, null, true);
  }
  const res = await endpoints.adminBulkBook({
    idempotencyKey: req.idempotencyKey, onBehalf: { guestName: label },
    allowNegativeBalance: false, items: itemsOf(slots),
  });
  return fromAdminBulk(res, slots, face, true);
}

async function bookAsAdmin(req: BookRequest): Promise<BookRun> {
  const { slots, who, face } = req;
  if (who.kind === "hold") return holdAsAdmin(req, who.label.trim());
  const memberId = who.kind === "member" ? who.userId : null;
  const payer = memberId ?? req.actorUserId;
  if (slots.length === 1 && payer) {
    const [s] = slots;
    const r = await endpoints.adminBook(s.courtId, payer, s.startsAt, s.sliceCount, req.allowNegativeBalance);
    return singleRun(s, face, r.balance_after_credits, false);
  }
  const res = await endpoints.adminBulkBook({
    idempotencyKey: req.idempotencyKey,
    // Omitted for the admin's own booking — the route's "self" shape.
    onBehalf: memberId ? { userId: memberId } : undefined,
    allowNegativeBalance: req.allowNegativeBalance,
    items: itemsOf(slots),
  });
  return fromAdminBulk(res, slots, face, false);
}

export function placeBooking(req: BookRequest): Promise<BookRun> {
  return req.isAdmin ? bookAsAdmin(req) : bookAsMember(req);
}
