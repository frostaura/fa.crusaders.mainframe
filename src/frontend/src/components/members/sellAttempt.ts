import { ApiError, endpoints, type ShelfPackage } from "@/lib/api";
import { adminEndpoints, type SellReasonCode } from "@/lib/adminApi";
import { errorCodeOf, newIdempotencyKey } from "@/lib/deskLedger";
import { LIVE_SAID, LOST_REPLY, SELL_COPY, adjustRefusal } from "@/lib/deskMinutesCopy";
import { balanceNow, rateLimited, refusedOutright, type AdjustmentKey } from "./adjustmentAttempt";

/**
 * One press of the desk's "Sell package" (P13 §3.7, `POST /admin/minutes/{id}/sell`) — posted,
 * and when its reply is lost, FOUND, with the adjust path's discipline (`adjustmentAttempt`).
 *
 * <p>
 * <b>The key names one intended sale</b>: this package, this payment, this note, this rand. A
 * different one is a different sale and gets a new key — except while the last outcome is still
 * unknown, when the old key is kept on purpose, so a sale that DID land answers the changed
 * press with `409 idempotency_key_reused` instead of selling twice.
 * </p>
 *
 * <p>
 * <b>A lost reply is looked up on the ledger.</b> A sale posts ONE `AdminTopUp` row of the
 * package's minutes whose reason is "{note} — {package name}" (§3.7), so such a row, written
 * since the press, IS this sale.
 * </p>
 */
export type SellInput = {
  userId: string;
  pkg: ShelfPackage;
  reasonCode: SellReasonCode;
  reason: string;
  /**
   * R9 J9-1: the member's price the admin was shown and confirmed. The server refuses a moved
   * shelf with 409 `package_price_changed` rather than recording a price nobody saw.
   */
  quotedPriceZar: number;
  /** The rand taken — always stated (0 for a package given free); the server never prices a sale. */
  zarReceived: number;
  /** Whose ledger to point at when the outcome cannot be found out. */
  name: string;
};

export type SellOutcome =
  | { kind: "sold"; balanceAfterMinutes: number | null; recovered: boolean }
  /** 409 `package_unavailable`: the shelf changed under the desk; the caller re-reads it. */
  | { kind: "unavailable"; message: string }
  /** 409 `package_price_changed` (R9 J9-1): nothing recorded; the package at its price now, when the body carried it. */
  | { kind: "repriced"; pkg: ShelfPackage | null }
  | { kind: "failed"; message: string; unchanged: boolean; said: string; balanceNow?: number | null };

/** How far before the press a row may be dated and still be this press's — client/server skew. */
const SKEW_MS = 2 * 60_000;

function fingerprintOf(input: SellInput): string {
  return JSON.stringify([input.pkg.id, input.reasonCode, input.reason.trim(), input.zarReceived, input.quotedPriceZar]);
}

/** The key this press travels under, per the rule in the header. */
export function saleKey(current: AdjustmentKey, input: SellInput): AdjustmentKey {
  const fingerprint = fingerprintOf(input);
  if (current && (current.fingerprint === fingerprint || current.unresolved)) return { ...current, fingerprint };
  return { key: newIdempotencyKey(), fingerprint, unresolved: false };
}

/** Whether a ledger row is this sale: a desk top-up of the package's minutes, with this note. */
export function isThisSale(row: { type: string; signedAmountMinutes: number; comment: string }, input: SellInput): boolean {
  return row.type === "AdminTopUp"
    && row.signedAmountMinutes === input.pkg.minutes
    && row.comment.trim().startsWith(input.reason.trim());
}

async function lookFor(input: SellInput, pressedAt: number): Promise<"landed" | "absent" | "unknown"> {
  try {
    const rows = await endpoints.adminLedger({ userId: input.userId, from: new Date(pressedAt - SKEW_MS).toISOString(), limit: 50 });
    return rows.some((row) => isThisSale(row, input)) ? "landed" : "absent";
  } catch {
    return "unknown";
  }
}

async function afterLostReply(input: SellInput, pressedAt: number, keyRef: { current: AdjustmentKey }): Promise<SellOutcome> {
  const found = await lookFor(input, pressedAt);
  if (found === "landed") {
    keyRef.current = null;
    return { kind: "sold", balanceAfterMinutes: await balanceNow(input.userId), recovered: true };
  }
  if (keyRef.current) keyRef.current = { ...keyRef.current, unresolved: found === "unknown" };
  return found === "absent"
    ? { kind: "failed", message: LOST_REPLY.absent, unchanged: true, said: LIVE_SAID.absent }
    : { kind: "failed", message: LOST_REPLY.unknown(input.name), unchanged: false, said: LIVE_SAID.unknown };
}

/** A 4xx: the server decided, so nothing moved — or, for a reused key, an earlier press did. */
async function refused(err: unknown, input: SellInput, keyRef: { current: AdjustmentKey }): Promise<SellOutcome> {
  const busy = rateLimited(err);
  if (busy) return { kind: "failed", message: busy, unchanged: true, said: busy };
  if (errorCodeOf(err) === "package_price_changed") {
    keyRef.current = null;
    return { kind: "repriced", pkg: repricedPackage(err) };
  }
  if (errorCodeOf(err) === "package_unavailable") {
    keyRef.current = null;
    return { kind: "unavailable", message: SELL_COPY.unavailable };
  }
  const message = adjustRefusal(err) ?? LOST_REPLY.refused;
  if (err instanceof ApiError && err.code === "idempotency_key_reused") {
    keyRef.current = null;
    return { kind: "failed", message, unchanged: true, said: LIVE_SAID.reused, balanceNow: await balanceNow(input.userId) };
  }
  if (keyRef.current) keyRef.current = { ...keyRef.current, unresolved: false };
  return { kind: "failed", message, unchanged: true, said: LIVE_SAID.refused };
}

/** The fresh shelf item a `package_price_changed` carries, or null when the body has none. */
function repricedPackage(err: unknown): ShelfPackage | null {
  const payload = err instanceof ApiError ? err.payload : null;
  const pkg = payload && typeof payload === "object" ? (payload as { package?: unknown }).package : null;
  if (!pkg || typeof pkg !== "object") return null;
  const item = pkg as Partial<ShelfPackage>;
  return typeof item.id === "string" && typeof item.price_zar === "number" ? (item as ShelfPackage) : null;
}

export async function attemptSale(input: SellInput, keyRef: { current: AdjustmentKey }): Promise<SellOutcome> {
  keyRef.current = saleKey(keyRef.current, input);
  const pressedAt = Date.now();
  try {
    const body = {
      packageId: input.pkg.id,
      reasonCode: input.reasonCode,
      reason: input.reason.trim(),
      quotedPriceZar: input.quotedPriceZar,
      zarReceived: input.zarReceived,
      idempotencyKey: keyRef.current!.key,
    };
    const r = await adminEndpoints.sellPackage(input.userId, body);
    keyRef.current = null;
    return { kind: "sold", balanceAfterMinutes: r.balance_after_minutes, recovered: false };
  } catch (err) {
    if (!refusedOutright(err)) return afterLostReply(input, pressedAt, keyRef);
    return refused(err, input, keyRef);
  }
}
