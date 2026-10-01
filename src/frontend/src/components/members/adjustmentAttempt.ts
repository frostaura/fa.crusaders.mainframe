import { ApiError, endpoints } from "@/lib/api";
import { rateLimitedSentence } from "@/lib/errors";
import { adminEndpoints, type AdjustmentReasonCode } from "@/lib/adminApi";
import { newIdempotencyKey, relatedBookingRefusal } from "@/lib/creditAdjustment";
import { memberDetailEndpoints } from "@/lib/memberDetailApi";
import { LIVE_SAID, LOST_REPLY, adjustRefusal } from "@/lib/deskMinutesCopy";

/**
 * One press of the desk's "Add / Take back" minutes (§3.7 `/adjust`) — posted, and when its reply is lost, FOUND.
 *
 * <p>
 * Shared by the members list (`useMinutesAdjust`) and the member's page (`useMemberTopUp`), which
 * carried the same machinery twice and the same defect twice (review round 2, F3-2): a reply lost
 * after the movement landed read "That didn't go through", and an admin who then corrected the
 * amount re-sent it under the same key and was told "didn't go through" again over a 409.
 * </p>
 *
 * <p>
 * <b>A lost reply is an unknown outcome, so the ledger is asked.</b> The movement's rows carry
 * the typed reason as their comment, so a row of the adjustment types, for this amount and this
 * reason, written since the press, IS this movement. Found: the receipt is shown, with the balance
 * re-read. Read and absent: nothing arrived — said plainly, and the key is KEPT so a retry that
 * races a late landing replays instead of posting twice. Not readable either: "not known yet",
 * never "didn't go through".
 * </p>
 *
 * <p>
 * <b>The key names one intended movement.</b> A different amount, reason, code, rand or booking
 * is a different movement and gets a new key — except while the last outcome is still unknown,
 * when the old key is kept on purpose: if that movement did land, the server answers the changed
 * payload with `409 idempotency_key_reused` and what it stored, which is the one way the admin
 * learns the truth before a second movement is posted.
 * </p>
 */
export type AdjustmentKey = { key: string; fingerprint: string; unresolved: boolean } | null;

export type AdjustmentInput = {
  userId: string;
  amount: number;
  reasonCode: AdjustmentReasonCode;
  reason: string;
  bookingId?: string;
  /** Whose ledger to point at when the outcome cannot be found out. */
  name: string;
};

export type AdjustmentOutcome =
  | { kind: "applied"; balanceAfterMinutes: number | null; recovered: boolean }
  | { kind: "booking"; message: string }
  | {
    kind: "failed"; message: string; unchanged: boolean;
    /** The short line the confirm's live region says — never "didn't go through" over an unknown. */
    said: string;
    /**
     * `409 idempotency_key_reused` proved an earlier press landed, so the balance on screen is
     * stale: the member's balance re-read (null where that read failed), for the caller to show.
     * Undefined for every other refusal, which moved nothing.
     */
    balanceNow?: number | null;
  };

const ADJUSTMENT_TYPES = new Set(["AdminAdjustment"]);
/** How far before the press a row may be dated and still be this press's — client/server skew. */
const SKEW_MS = 2 * 60_000;

function fingerprintOf(input: AdjustmentInput): string {
  return JSON.stringify([input.amount, input.reasonCode, input.reason, input.bookingId ?? null]);
}

/** The key this press travels under, per the rule in the header. */
export function keyForPress(current: AdjustmentKey, input: AdjustmentInput): AdjustmentKey {
  const fingerprint = fingerprintOf(input);
  if (current && (current.fingerprint === fingerprint || current.unresolved)) return { ...current, fingerprint };
  return { key: newIdempotencyKey(), fingerprint, unresolved: false };
}

/** A reply that says the server decided: any 4xx. Everything else might have landed. */
export function refusedOutright(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

/** The rate limit's sentence, with the wait the club named, or null for anything else. */
export function rateLimited(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  return `${rateLimitedSentence(Number(err.detail("retry_after_seconds")) || null)} Nothing was changed.`;
}

type Found = "landed" | "absent" | "unknown";

/** Ask the ledger whether this press's movement is on it. */
async function lookFor(input: AdjustmentInput, pressedAt: number): Promise<Found> {
  try {
    const rows = await endpoints.adminLedger({
      userId: input.userId, from: new Date(pressedAt - SKEW_MS).toISOString(), limit: 50,
    });
    const reason = input.reason.trim();
    const hit = rows.some((row) => ADJUSTMENT_TYPES.has(row.type)
      && row.signedAmountMinutes === input.amount
      && row.comment.trim() === reason);
    return hit ? "landed" : "absent";
  } catch {
    return "unknown";
  }
}

/** The balance now, or null — never a zero standing in for a read that failed. */
export async function balanceNow(userId: string): Promise<number | null> {
  try {
    const detail = await memberDetailEndpoints.detail(userId);
    return typeof detail?.balance_minutes === "number" ? detail.balance_minutes : null;
  } catch {
    return null;
  }
}

async function afterLostReply(input: AdjustmentInput, pressedAt: number, keyRef: { current: AdjustmentKey }): Promise<AdjustmentOutcome> {
  const found = await lookFor(input, pressedAt);
  if (found === "landed") {
    keyRef.current = null;
    return { kind: "applied", balanceAfterMinutes: await balanceNow(input.userId), recovered: true };
  }
  if (keyRef.current) keyRef.current = { ...keyRef.current, unresolved: found === "unknown" };
  return found === "absent"
    ? { kind: "failed", message: LOST_REPLY.absent, unchanged: true, said: LIVE_SAID.absent }
    : { kind: "failed", message: LOST_REPLY.unknown(input.name), unchanged: false, said: LIVE_SAID.unknown };
}

export async function attemptAdjustment(
  input: AdjustmentInput, keyRef: { current: AdjustmentKey },
): Promise<AdjustmentOutcome> {
  keyRef.current = keyForPress(keyRef.current, input);
  const pressedAt = Date.now();
  try {
    const r = await adminEndpoints.adjustCredit(input.userId, {
      amountMinutes: input.amount,
      reasonCode: input.reasonCode,
      reason: input.reason,
      ...(input.bookingId ? { relatedBookingId: input.bookingId } : {}),
      idempotencyKey: keyRef.current!.key,
    });
    keyRef.current = null;
    return { kind: "applied", balanceAfterMinutes: r.balance_after_minutes, recovered: false };
  } catch (err) {
    const booking = relatedBookingRefusal(err);
    if (booking) return { kind: "booking", message: booking };
    if (!refusedOutright(err)) return afterLostReply(input, pressedAt, keyRef);
    // R4 I4-4: the club's rate limit turns a press away before it is read — it is not a refusal
    // of THIS adjustment ("The club refused that adjustment"), and pressing again after the wait
    // is the right thing to do. The key stays: a later press is still this movement.
    const busy = rateLimited(err);
    if (busy) return { kind: "failed", message: busy, unchanged: true, said: busy };
    // A refusal settles the question. `idempotency_key_reused` settles it the other way: the
    // earlier movement DID land, the sentence says what it was, and the next press is a new one.
    const message = adjustRefusal(err) ?? LOST_REPLY.refused;
    if (err instanceof ApiError && err.code === "idempotency_key_reused") {
      keyRef.current = null;
      // It LANDED, so the figure the sheet shows is from before it (review round 3, I-6).
      return { kind: "failed", message, unchanged: true, said: LIVE_SAID.reused, balanceNow: await balanceNow(input.userId) };
    }
    if (keyRef.current) keyRef.current = { ...keyRef.current, unresolved: false };
    return { kind: "failed", message, unchanged: true, said: LIVE_SAID.refused };
  }
}
