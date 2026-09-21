import type { BulkBookResponse, BulkCancelResponse, BulkResultRow } from "./api";

/**
 * A batch's per-item outcomes, read defensively.
 *
 * <p>
 * <b>Why this module is defensive and the rest of `lib/api` is not.</b> Every other response in
 * this client is read by a screen that would visibly break on a mis-spelt key. A bulk result
 * row would not: it would render as a row with a blank reason and a blank amount, on the one
 * screen an admin uses to audit twelve refunds at once, and nothing would say the screen had
 * failed to understand the server. So both spellings of every key are accepted, and an
 * unrecognised STATUS counts as a failure rather than as a success — a cancellation this
 * client cannot describe is not a cancellation it should report as done.
 * </p>
 */

export type BulkRow = {
  /** The booking id, for a cancel; the item index, for a book. Stable, for React and for retry. */
  id: string;
  ok: boolean;
  status: string;
  error: string | null;
  courtName: string | null;
  startsAt: string | null;
  memberName: string | null;
  refundCredits: number;
  penaltyCredits: number;
  amountCredits: number;
  /** True when the row is a success that returned nothing to the member — the lights were on. */
  nothingBack: boolean;
};

/** D2 §5.2's closed set. `already_cancelled` and `block_lifted` are SUCCESSES — see the tests. */
const CANCEL_OK = new Set(["cancelled", "already_cancelled", "block_lifted"]);
/** D2 §5.3's closed set. `duplicate` is a success: that exact item already landed under this key. */
const BOOK_OK = new Set(["booked", "blocked", "duplicate"]);

export function readCancelResults(res: BulkCancelResponse | null | undefined): BulkRow[] {
  return rowsOf(res).map((raw, i) => {
    const status = str(pick(raw, "status")) ?? "failed";
    const refund = numOr0(pick(raw, "refund_credits", "refundCredits"));
    const penalty = numOr0(pick(raw, "penalty_credits", "penaltyCredits"));
    return {
      id: str(pick(raw, "booking_id", "bookingId")) ?? `row-${i}`,
      ok: CANCEL_OK.has(status),
      status,
      error: str(pick(raw, "error")),
      courtName: str(pick(raw, "court_name", "courtName")),
      startsAt: str(pick(raw, "starts_at", "startsAt")),
      memberName: str(pick(raw, "member_name", "memberName")),
      refundCredits: refund, penaltyCredits: penalty, amountCredits: 0,
      nothingBack: CANCEL_OK.has(status) && status !== "already_cancelled" && refund <= 0 && penalty <= 0,
    };
  });
}

export function readBookResults(res: BulkBookResponse | null | undefined): BulkRow[] {
  return rowsOf(res).map((raw, i) => {
    const status = str(pick(raw, "status")) ?? "failed";
    return {
      id: String(num(pick(raw, "index")) ?? i),
      ok: BOOK_OK.has(status),
      status,
      error: str(pick(raw, "error")),
      courtName: str(pick(raw, "court_name", "courtName")),
      startsAt: str(pick(raw, "starts_at", "startsAt")),
      memberName: str(pick(raw, "member_name", "memberName")),
      refundCredits: 0, penaltyCredits: 0,
      amountCredits: numOr0(pick(raw, "amount_credits", "amountCredits")),
      nothingBack: false,
    };
  });
}

export type CancelTotals = {
  succeeded: number; failed: number;
  refundCredits: number; penaltyCredits: number; nothingBack: number;
};

/**
 * The totals, summed from the ROWS.
 *
 * <p>
 * Never from the envelope's own `total_refunded_credits`. If the two disagree it is a server
 * defect, and printing a figure no row accounts for on a screen used to audit refunds turns
 * that defect into a club's missing money with no way to find it. The rows are what the admin
 * can see; the total has to be their sum.
 * </p>
 */
export function summariseCancel(rows: readonly BulkRow[]): CancelTotals {
  return rows.reduce<CancelTotals>((acc, r) => ({
    succeeded: acc.succeeded + (r.ok ? 1 : 0),
    failed: acc.failed + (r.ok ? 0 : 1),
    refundCredits: acc.refundCredits + r.refundCredits,
    penaltyCredits: acc.penaltyCredits + r.penaltyCredits,
    nothingBack: acc.nothingBack + (r.nothingBack ? 1 : 0),
  }), { succeeded: 0, failed: 0, refundCredits: 0, penaltyCredits: 0, nothingBack: 0 });
}

export type BookTotals = {
  succeeded: number; failed: number; chargedCredits: number;
  haltedAt: number | null; haltedReason: string | null;
  balanceAfterCredits: number | null; payerName: string | null;
};

export function summariseBook(rows: readonly BulkRow[], res?: BulkBookResponse | null): BookTotals {
  const payer = (res?.payer ?? {}) as Record<string, unknown>;
  return {
    succeeded: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    chargedCredits: rows.reduce((n, r) => n + r.amountCredits, 0),
    haltedAt: num(pick(res ?? {}, "halted_at", "haltedAt")),
    haltedReason: str(pick(res ?? {}, "halted_reason", "haltedReason")),
    balanceAfterCredits: num(pick(payer, "balance_after_credits", "balanceAfterCredits")),
    payerName: str(pick(payer, "name")),
  };
}

/* ─────────────────────────── reading ─────────────────────────── */

function rowsOf(res: { results?: BulkResultRow[] } | null | undefined): Record<string, unknown>[] {
  const rows = res && typeof res === "object" ? (res as Record<string, unknown>).results : undefined;
  return Array.isArray(rows) ? rows.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object") : [];
}

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (raw[key] !== undefined) return raw[key];
  return undefined;
}

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function num(v: unknown): number | null { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function numOr0(v: unknown): number { return num(v) ?? 0; }
