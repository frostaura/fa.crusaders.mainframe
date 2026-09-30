import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { endpoints, type BulkCancelResponse, type CancellationQuote } from "@/lib/api";
import { formatMinutes } from "@/lib/utils";
import { clubClock } from "@/lib/clubClock";
import { UnsureOutcome, goneFrom, outcomeUnknown, type Reread } from "@/lib/bookingOutcome";
import { splitCancelOf, type PartnerRefund, type SplitCancel } from "@/lib/bookingsApi";
import { CANCEL_SHEET, cancelRowOutcome, refusalReason, RESULT_WORD, splitRowOutcome } from "@/lib/bookingsCopy";
import { clubDayLabel, newIdempotencyKey } from "./bookFlow";
import type { BulkResultRow } from "./BulkResults";
import type { GridBooking } from "./types";

/**
 * CancelSheet's money and calls. The figures come from the server's cancellation quote the moment
 * the sheet opens — never from the schedule and never from arithmetic repeated here — because the
 * answer turns on the clock and on whether somebody has scanned in, and both move after a grid is
 * loaded.
 */

/* ─────────────────────────────── quotes ─────────────────────────────── */

/** Per booking: its quote, or `null` when that one quote could not be read. */
export type QuoteMap = Map<string, CancellationQuote | null>;

export type CancelQuotes =
  | { status: "loading" }
  | { status: "ready"; quotes: QuoteMap };

/**
 * One quote per booking, in parallel. A quote that will not load is recorded as `null` for that
 * booking alone — one bad read must not blank the other eleven, and a row with no quote says so
 * rather than claiming a refund of nothing.
 */
export function useCancelQuotes(bookings: readonly GridBooking[]) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; quotes: QuoteMap } | null>(null);
  const latest = useRef(bookings);
  useLayoutEffect(() => { latest.current = bookings; });
  const requestKey = `${bookings.map((b) => b.bookingId).join("|")}#${attempt}`;

  useEffect(() => {
    let live = true;
    const reads = latest.current.map((b) =>
      endpoints.cancellationQuote(b.bookingId).then(
        (q) => [b.bookingId, q] as const,
        () => [b.bookingId, null] as const,
      ));
    void Promise.all(reads).then((pairs) => {
      if (live) setAnswer({ key: requestKey, quotes: new Map(pairs) });
    });
    return () => { live = false; };
  }, [requestKey]);

  const state: CancelQuotes = answer && answer.key === requestKey
    ? { status: "ready", quotes: answer.quotes }
    : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}

/* ─────────────────────────────── figures ─────────────────────────────── */

/**
 * What one booking's cancellation moves, with a waiver applied (the waiver returns the penalty).
 * On a split booking (contract §3) `back` is what the ORGANISER keeps after the partners' shares
 * go back to them, and `partners` says who gets what (F1.13) — the whole refund used to be
 * called "Back to you" while most of it was on its way to the partners.
 */
export function netOf(quote: CancellationQuote, waived: boolean): { back: number; penalty: number; partners: PartnerRefund[] } {
  if (quote.checkedIn) return { back: 0, penalty: 0, partners: [] };
  const split = splitCancelOf(quote);
  const partners = split?.partners ?? [];
  // A waiver returns the penalty, which is the organiser's alone: their net grows by it.
  if (waived) return { back: split ? split.net + quote.penaltyCredits : quote.amountChargedCredits, penalty: 0, partners };
  return { back: split ? split.net : quote.refundCredits, penalty: quote.penaltyCredits, partners };
}

export type CancelTotals = { back: number; penalty: number; nothingBack: number; missing: number; anyPenalty: boolean };

export function totalsOf(bookings: readonly GridBooking[], quotes: QuoteMap | null, waived: boolean): CancelTotals {
  const totals: CancelTotals = { back: 0, penalty: 0, nothingBack: 0, missing: 0, anyPenalty: false };
  for (const b of bookings) {
    const q = quotes?.get(b.bookingId);
    if (!q) { totals.missing += 1; continue; }
    const { back, penalty } = netOf(q, waived);
    totals.back += back;
    totals.penalty += penalty;
    if (back <= 0) totals.nothingBack += 1;
    if (q.penaltyCredits > 0 && !q.checkedIn) totals.anyPenalty = true;
  }
  return totals;
}

/** "Tue 23 Sep", "18:00–18:45", "45 min" for a booking, in the club's clock. */
export function bookingFace(b: GridBooking) {
  const start = new Date(b.startsAt);
  const end = new Date(b.endsAt);
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  const day = clubDayLabel(start, b.timezone);
  return { day, time: `${clubClock(start, b.timezone)}–${clubClock(end, b.timezone)}`, duration: formatMinutes(minutes) };
}

/** The per-row money note on a multi-booking sheet. */
export function quoteNote(quote: CancellationQuote | null | undefined, waived: boolean): string {
  if (quote === undefined) return "";
  if (quote === null) return CANCEL_SHEET.quoteMissing;
  const { back, penalty } = netOf(quote, waived);
  if (quote.checkedIn || (back <= 0 && penalty <= 0)) return CANCEL_SHEET.nothingBack;
  return cancelRowOutcome(back + penalty, penalty);
}

/* ─────────────────────────────── the call ─────────────────────────────── */

export type CancelRequest = {
  bookings: readonly GridBooking[];
  isAdmin: boolean;
  waive: boolean;
  reason: string;
  idempotencyKey: string;
  /** Re-reads the day behind the sheet — how an unanswered cancel learns what happened (F1.1). */
  reread?: Reread;
  /**
   * The quotes the sheet showed. A route that does not answer the split figures (the desk's
   * cancel, the bulk) is told them from here, so the outcome never calls a partner's share the
   * organiser's (F1.13: "250.00 cr back to Adm" while 125 went to the partner).
   */
  quotes?: QuoteMap | null;
};

/** What one cancel moved. Null figures: it was cancelled, but the reply that said how much was lost. */
export type CancelFigures = { refunded: number | null; penalty: number | null; split?: SplitCancel | null };

/** The split a cancel moved: from its own answer when it says, else from the quote the sheet showed. */
function splitFor(b: GridBooking, answer: unknown, req: CancelRequest): SplitCancel | null {
  const said = splitCancelOf(answer as Record<string, unknown>);
  if (said) return said;
  const quote = req.quotes?.get(b.bookingId) ?? null;
  if (!quote || quote.checkedIn) return null;
  const { back, partners } = netOf(quote, req.waive);
  return partners.length ? { net: back, partners } : null;
}

export type CancelRun = {
  rows: BulkResultRow[];
  cancelledIds: string[];
  /** Single cancellation's figures, for the toast. */
  single: CancelFigures | null;
};

function whenOf(b: GridBooking): string {
  const f = bookingFace(b);
  return `${f.day} · ${f.time}`;
}

function nameOf(b: GridBooking): string {
  return b.mine || !b.memberFirstName ? b.courtName : `${b.courtName} · ${b.memberFirstName}`;
}

function okRow(b: GridBooking, refunded: number | null, penalty: number | null, split: SplitCancel | null = null): BulkResultRow {
  let detail: string;
  if (refunded === null || penalty === null) detail = CANCEL_SHEET.provenRow;
  else if (split) detail = splitRowOutcome(split.net, split.partners.reduce((n, p) => n + p.credits, 0), penalty);
  else detail = cancelRowOutcome(refunded, penalty);
  return { key: b.bookingId, courtName: nameOf(b), when: whenOf(b), ok: true, word: RESULT_WORD.cancelled, detail };
}

function failedRow(b: GridBooking, code: string | null): BulkResultRow {
  return {
    key: b.bookingId, courtName: nameOf(b), when: whenOf(b), ok: false,
    word: RESULT_WORD.notCancelled, detail: refusalReason(code),
  };
}

async function cancelOne(b: GridBooking, req: CancelRequest) {
  // An admin cancelling somebody else's booking goes through the admin route (waiver + reason);
  // one's own booking — an admin's included — through the member route, as a member would.
  return !b.mine && req.isAdmin
    ? endpoints.adminCancelBooking(b.bookingId, req.waive, req.waive ? req.reason.trim() : "")
    : endpoints.cancelBooking(b.bookingId);
}

const BULK_OK = new Set(["cancelled", "already_cancelled", "block_lifted"]);

function fromBulk(res: BulkCancelResponse, bookings: readonly GridBooking[], req: CancelRequest): CancelRun {
  const byId = new Map(bookings.map((b) => [b.bookingId, b]));
  const rows: BulkResultRow[] = [];
  const cancelledIds: string[] = [];
  for (const raw of res.results ?? []) {
    const b = byId.get(String(raw.booking_id ?? ""));
    if (!b) continue;
    const status = typeof raw.status === "string" ? raw.status : "failed";
    if (!BULK_OK.has(status)) {
      rows.push(failedRow(b, typeof raw.error === "string" ? raw.error : null));
      continue;
    }
    cancelledIds.push(b.bookingId);
    const refund = typeof raw.refund_credits === "number" ? raw.refund_credits : 0;
    const penalty = typeof raw.penalty_credits === "number" ? raw.penalty_credits : 0;
    rows.push(status === "already_cancelled"
      ? { ...okRow(b, 0, 0), detail: refusalReason("already_cancelled") }
      : okRow(b, refund, penalty, splitFor(b, raw, req)));
  }
  return { rows, cancelledIds, single: null };
}

/**
 * The rows the schedule proves for bookings whose cancel went unanswered: gone is cancelled
 * (the reply with the figures was lost), still there is not, and a failed look says it cannot
 * tell. Never "couldn't cancel" about a booking the club had cancelled and refunded (F1.1).
 */
async function proveCancels(unsure: readonly GridBooking[], reread: Reread | undefined) {
  const day = reread ? await reread() : null;
  const rows = new Map<string, BulkResultRow>();
  const gone: string[] = [];
  for (const b of unsure) {
    if (day && goneFrom(day, b.bookingId)) {
      gone.push(b.bookingId);
      rows.set(b.bookingId, okRow(b, null, null));
    } else {
      rows.set(b.bookingId, { ...failedRow(b, null), detail: day ? CANCEL_SHEET.unsureStillThere : CANCEL_SHEET.unsureRow });
    }
  }
  return { rows, gone };
}

function codeOf(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error ? (error as { code: string | null }).code : null;
}

/** Several of one's own bookings, one after another: each is its own refund behind its own lock. */
async function cancelInTurn(req: CancelRequest): Promise<CancelRun> {
  const rows: BulkResultRow[] = [];
  const cancelledIds: string[] = [];
  const unsure: GridBooking[] = [];
  for (const b of req.bookings) {
    try {
      const r = await cancelOne(b, req);
      rows.push(okRow(b, r.refunded_credits, r.penalty_credits, splitFor(b, r, req)));
      cancelledIds.push(b.bookingId);
    } catch (error) {
      if (outcomeUnknown(error)) unsure.push(b);
      rows.push(failedRow(b, codeOf(error)));
    }
  }
  if (unsure.length === 0) return { rows, cancelledIds, single: null };
  const proven = await proveCancels(unsure, req.reread);
  return {
    rows: rows.map((r) => proven.rows.get(r.key) ?? r),
    cancelledIds: [...cancelledIds, ...proven.gone],
    single: null,
  };
}

async function cancelSingle(b: GridBooking, req: CancelRequest): Promise<CancelRun> {
  try {
    const r = await cancelOne(b, req);
    const split = splitFor(b, r, req);
    return { rows: [okRow(b, r.refunded_credits, r.penalty_credits, split)], cancelledIds: [b.bookingId],
      single: { refunded: r.refunded_credits, penalty: r.penalty_credits, split } };
  } catch (error) {
    if (!outcomeUnknown(error) || !req.reread) throw error;
    const day = await req.reread();
    if (!day) throw new UnsureOutcome(error, false);
    if (!goneFrom(day, b.bookingId)) throw new UnsureOutcome(error, true);
    return { rows: [okRow(b, null, null)], cancelledIds: [b.bookingId], single: { refunded: null, penalty: null } };
  }
}

/** The admin bulk route, with an unanswered batch read back off the schedule row by row. */
async function cancelAsDesk(req: CancelRequest): Promise<CancelRun> {
  const { bookings } = req;
  try {
    const res = await endpoints.adminBulkCancel({
      idempotencyKey: req.idempotencyKey, reason: req.reason.trim(), waivePenalty: req.waive,
      items: bookings.map((b) => ({ bookingId: b.bookingId })),
    });
    return fromBulk(res, bookings, req);
  } catch (error) {
    if (!outcomeUnknown(error)) throw error;
    const proven = await proveCancels(bookings, req.reread);
    return { rows: bookings.map((b) => proven.rows.get(b.bookingId)!), cancelledIds: proven.gone, single: null };
  }
}

export async function cancelBookings(req: CancelRequest): Promise<CancelRun> {
  const { bookings } = req;
  if (bookings.length === 1) return cancelSingle(bookings[0], req);
  // A batch that touches somebody else's booking is the admin bulk route: one reason, recorded
  // once for the batch and sent in every member's email.
  if (req.isAdmin && bookings.some((b) => !b.mine)) return cancelAsDesk(req);
  return cancelInTurn(req);
}

export function newCancelKey(): string {
  return newIdempotencyKey("bc");
}
