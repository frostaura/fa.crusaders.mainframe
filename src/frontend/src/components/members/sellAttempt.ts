import { ApiError, endpoints, type ShelfPackage } from "@/lib/api";
import { adminEndpoints, type SellReasonCode } from "@/lib/adminApi";
import { errorCodeOf, newIdempotencyKey } from "@/lib/creditAdjustment";
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
  /** Undefined = the member's shelf price, which the server defaults to. */
  zarReceived?: number;
  /** Whose ledger to point at when the outcome cannot be found out. */
  name: string;
};

export type SellOutcome =
  | { kind: "sold"; balanceAfterMinutes: number | null; recovered: boolean }
  /** 409 `package_unavailable`: the shelf changed under the desk; the caller re-reads it. */
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string; unchanged: boolean; said: string; balanceNow?: number | null };

/** How far before the press a row may be dated and still be this press's — client/server skew. */
const SKEW_MS = 2 * 60_000;

function fingerprintOf(input: SellInput): string {
  return JSON.stringify([input.pkg.id, input.reasonCode, input.reason.trim(), input.zarReceived ?? null]);
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

export async function attemptSale(input: SellInput, keyRef: { current: AdjustmentKey }): Promise<SellOutcome> {
  keyRef.current = saleKey(keyRef.current, input);
  const pressedAt = Date.now();
  try {
    const r = await adminEndpoints.sellPackage(input.userId, {
      packageId: input.pkg.id,
      reasonCode: input.reasonCode,
      reason: input.reason.trim(),
      ...(input.zarReceived !== undefined ? { zarReceived: input.zarReceived } : {}),
      idempotencyKey: keyRef.current!.key,
    });
    keyRef.current = null;
    return { kind: "sold", balanceAfterMinutes: r.balance_after_minutes, recovered: false };
  } catch (err) {
    if (!refusedOutright(err)) return afterLostReply(input, pressedAt, keyRef);
    return refused(err, input, keyRef);
  }
}
