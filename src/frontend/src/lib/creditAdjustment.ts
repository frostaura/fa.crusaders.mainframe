import { ApiError, type LedgerEntryType, type LedgerRow } from "./api";
import { formatCredits } from "./utils";

/**
 * The pure logic behind the admin console's "adjust credit" form.
 *
 * <p>
 * It lives in a `.ts` module rather than beside the screen it serves, and that is a
 * deliberate consequence of the gate: lizard's `.tsx` parser loses brace synchronisation
 * inside JSX and then attributes every function after the desync to the last one it was
 * sure of, so a five-line refusal mapper is reported as a 294-line function and
 * `make complexity` fails naming a function that does not exist. Pure helpers in a plain
 * `.ts` file are measured as what they are — and they are easier to test besides.
 * </p>
 */

/**
 * A name for one intended credit movement.
 *
 * <p>
 * `crypto.randomUUID` needs a secure context and is absent under plain HTTP on a LAN
 * address — which is exactly where a club's admin laptop sits — so a fallback is not
 * theoretical here. It does not need to be unguessable: the server scopes the key to the
 * tenant and it only ever suppresses a repeat of the desk's own adjustment, so
 * "distinct with overwhelming probability" is the whole requirement.
 * </p>
 */
export function newIdempotencyKey(): string {
  // Reached through a Record rather than an inline `Crypto & { randomUUID?: () => string }`
  // intersection, for the reason {@link patchMember} carries: a brace-bearing type literal
  // desynchronises lizard's .tsx brace counting and `make complexity` then reports
  // functions that do not exist.
  const source = globalThis.crypto as unknown as Record<string, unknown>;
  const uuid = source?.randomUUID;
  if (typeof uuid === "function") return String((uuid as () => string).call(globalThis.crypto));
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

// --- "for booking" on a credit adjustment --------------------------------------

export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isGuid(value: string) { return GUID.test(value); }

/**
 * What is wrong with the form, in the desk's words, or null when nothing is.
 *
 * <p>
 * The GUID check is here rather than left to the server because the endpoint binds
 * <code>RelatedBookingId</code> as a <code>Guid?</code> and answers a bare 400 with no
 * body for anything that is not one — a refusal an admin cannot act on. The two refusals
 * the endpoint <em>does</em> explain are handled after the round trip, in
 * {@link relatedBookingRefusal}.
 * </p>
 */
export function validateAdjustment(amountText: string, reason: string, bookingId: string): string | null {
  const amount = parseFloat(amountText);
  if (isNaN(amount) || amount === 0) return "Enter a non-zero amount.";
  if (!reason.trim()) return "A reason is required.";
  if (bookingId && !isGuid(bookingId)) return "That booking ID is not one — it should look like 8-4-4-4-12 hex characters. Pick one from the list or leave it blank.";
  return null;
}

/**
 * The two ways the server refuses the booking a hand adjustment names (settlement-model
 * I4), told apart.
 *
 * <p>
 * They are different mistakes with different repairs, and a generic "adjustment failed"
 * sends the admin back round the same loop. <code>booking_not_found</code> is a
 * mis-keyed or foreign id — including another club's, which this tenant cannot see and
 * so does not have. <code>booking_not_members</code> is a real booking of the wrong
 * member's, which is the dangerous one: it is the mistake I4 exists to stop, because
 * before the check it silently netted against a third party's settlement and left
 * nothing on their ledger to explain it.
 * </p>
 */
export const RELATED_BOOKING_REFUSAL: Record<string, string> = {
  booking_not_found:
    "No booking with that ID exists at this club. Check it against the club's own records, or pick one from the list — the list is every booking this member's money has moved on.",
  booking_not_members:
    "That booking belongs to another member. Naming it here would net against THEIR reversal and change what they are owed, so the server refused it. Pick one of this member's own bookings.",
};

/**
 * The API's stable snake_case error code, or the empty string.
 *
 * Written as statements rather than as `... ? (err.payload as Record<...>) : {}`, for the
 * reason {@link patchMember} carries: an object literal inside a ternary desynchronises
 * lizard's .tsx brace counting, and `make complexity` then reports a 366-line function
 * where there are nine.
 */
export function errorCodeOf(err: unknown): string {
  if (!(err instanceof ApiError)) return "";
  const payload = err.payload;
  if (typeof payload !== "object" || payload === null) return "";
  const code = (payload as Record<string, unknown>).error;
  return typeof code === "string" ? code : "";
}

export function relatedBookingRefusal(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 400) return null;
  return RELATED_BOOKING_REFUSAL[errorCodeOf(err)] ?? null;
}

/** Sentinel option value: the admin will type a booking ID the ledger has not seen. */
export const OTHER_BOOKING = "other";

export type RecentBooking = { id: string; label: string };

/**
 * What each ledger type is called in the picker — the wording LedgerRowMapper uses for
 * the same rows, so a booking reads the same here as on the ledger page. A Record over
 * the union, so a type added on the backend fails to compile here rather than showing
 * up unlabelled.
 */
export const LEDGER_TYPE_LABEL: Record<LedgerEntryType, string> = {
  TopUp: "Wallet top-up",
  BookingCharge: "Booking charge",
  CancellationRefund: "Cancellation refund",
  NoShowPenalty: "No-show penalty",
  LateCancellationPenalty: "Late-cancellation penalty",
  AdminAdjustment: "Admin adjustment",
  PaymentReversal: "Payment reversal",
  LightsPurchase: "Lights purchase",
  ShareTransfer: "Share of a split booking",
};

/**
 * The bookings the ledger knows this member by, newest first, one entry per booking.
 *
 * There is no admin endpoint that lists a member's bookings, and none is needed for
 * this: every charge, penalty and refund row carries `relatedBookingId`, so the ledger
 * filtered to the member is the list of bookings money has moved on — which is the
 * list an adjustment could be compensating for. A no-show penalty row is the usual
 * pick, and that is exactly the case the field exists for.
 */
export function recentBookingsFrom(rows: LedgerRow[]): RecentBooking[] {
  const seen = new Set<string>();
  const out: RecentBooking[] = [];
  for (const row of rows) {
    const id = row.relatedBookingId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const when = new Date(row.at).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
    out.push({ id, label: `${when} · ${LEDGER_TYPE_LABEL[row.type] ?? row.type} ${formatCredits(row.amountCredits)} · ${id.slice(0, 8)}` });
  }
  return out;
}
