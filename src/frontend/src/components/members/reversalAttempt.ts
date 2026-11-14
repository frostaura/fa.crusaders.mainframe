import { ApiError } from "@/lib/api";
import { adminEndpoints, type ReversalKind, type ReversibleEntry } from "@/lib/adminApi";
import { newIdempotencyKey } from "@/lib/deskLedger";
import { parseAmount } from "@/lib/amount";
import { formatMoney } from "@/lib/utils";
import { LIVE_SAID } from "@/lib/deskMinutesCopy";
import { REVERSAL_COPY as COPY, REVERSAL_LOST, reversalRefusal } from "@/lib/reversalCopy";
import { rateLimited, refusedOutright, type AdjustmentKey } from "./adjustmentAttempt";

/**
 * One press of "Record refund / chargeback" (BM-6, `POST /admin/minutes/{id}/reverse-payment`) —
 * posted, and when its reply is lost, FOUND, with the desk's press discipline.
 *
 * <p>
 * <b>The key names one intended reversal</b> — this purchase, this kind, this rand, these minutes,
 * this note — exactly as a sale's does: a changed one gets a new key, except while the last outcome
 * is unknown, when the old key is kept so a reversal that DID land answers the changed press with
 * <code>409 idempotency_key_reused</code> instead of giving money back twice.
 * </p>
 *
 * <p>
 * <b>A lost reply is looked up on the purchase itself.</b> The reversible read says how much rand
 * and how many minutes have gone back on each purchase; if they grew by at least this press's since
 * it was read, the press landed. Read and not grown: nothing arrived, the key is kept. Unreadable:
 * "not known yet", never "didn't go through".
 * </p>
 */
export type ReversalInput = {
  userId: string;
  /** The purchase as it was read when the sheet showed it: its `zar_reversed` and `minutes_taken_back` are the baseline. */
  entry: ReversibleEntry;
  kind: ReversalKind;
  zar: number;
  minutes: number;
  reason: string;
  name: string;
};

export type ReversalOutcome =
  | { kind: "recorded"; balanceAfterMinutes: number | null; zarLeft: number | null; minutesLeft: number | null; recovered: boolean }
  /** 409 reversal_exceeds_payment: what is left on the purchase NOW, for the sheet to show and re-check against. */
  | { kind: "exceeds"; message: string; zarLeft: number | null; minutesLeft: number | null }
  | { kind: "failed"; message: string; unchanged: boolean; said: string };

function fingerprintOf(input: ReversalInput): string {
  return JSON.stringify([input.entry.entry_id, input.kind, input.zar, input.minutes, input.reason.trim()]);
}

/** The key this press travels under, per the rule in the header. */
export function reversalKey(current: AdjustmentKey, input: ReversalInput): AdjustmentKey {
  const fingerprint = fingerprintOf(input);
  if (current && (current.fingerprint === fingerprint || current.unresolved)) return { ...current, fingerprint };
  return { key: newIdempotencyKey(), fingerprint, unresolved: false };
}

/** Rand compared in whole cents, so 0.1 + 0.2 never decides whether money moved. */
const cents = (zar: number) => Math.round(zar * 100);

async function lookFor(input: ReversalInput): Promise<{ found: "landed" | "absent" | "unknown"; now?: ReversibleEntry }> {
  try {
    const { entries } = await adminEndpoints.reversible(input.userId);
    const now = entries.find((e) => e.entry_id === input.entry.entry_id);
    if (!now) return { found: "unknown" };
    const grew = cents(now.zar_reversed) - cents(input.entry.zar_reversed) >= cents(input.zar)
      && now.minutes_taken_back - input.entry.minutes_taken_back >= input.minutes;
    return { found: grew ? "landed" : "absent", now };
  } catch {
    return { found: "unknown" };
  }
}

async function afterLostReply(input: ReversalInput, keyRef: { current: AdjustmentKey }): Promise<ReversalOutcome> {
  const { found, now } = await lookFor(input);
  if (found === "landed") {
    keyRef.current = null;
    return { kind: "recorded", balanceAfterMinutes: null, zarLeft: now?.zar_left ?? null, minutesLeft: now?.minutes_left ?? null, recovered: true };
  }
  if (keyRef.current) keyRef.current = { ...keyRef.current, unresolved: found === "unknown" };
  return found === "absent"
    ? { kind: "failed", message: REVERSAL_LOST.absent, unchanged: true, said: LIVE_SAID.absent }
    : { kind: "failed", message: REVERSAL_LOST.unknown(input.name), unchanged: false, said: LIVE_SAID.unknown };
}

function refused(err: unknown, keyRef: { current: AdjustmentKey }): ReversalOutcome {
  const busy = rateLimited(err);
  if (busy) return { kind: "failed", message: busy, unchanged: true, said: busy };
  const message = reversalRefusal(err) ?? "The club refused that. Nothing was recorded.";
  if (err instanceof ApiError && err.code === "reversal_exceeds_payment") {
    keyRef.current = null;
    const zar = Number(err.detail("zar_left"));
    const minutes = Number(err.detail("minutes_left"));
    return { kind: "exceeds", message, zarLeft: Number.isFinite(zar) ? zar : null, minutesLeft: Number.isFinite(minutes) ? minutes : null };
  }
  if (err instanceof ApiError && err.code === "idempotency_key_reused") {
    keyRef.current = null;
    return { kind: "failed", message, unchanged: true, said: LIVE_SAID.reused };
  }
  if (keyRef.current) keyRef.current = { ...keyRef.current, unresolved: false };
  return { kind: "failed", message, unchanged: true, said: LIVE_SAID.refused };
}

export async function attemptReversal(input: ReversalInput, keyRef: { current: AdjustmentKey }): Promise<ReversalOutcome> {
  keyRef.current = reversalKey(keyRef.current, input);
  try {
    const r = await adminEndpoints.reversePayment(input.userId, {
      entryId: input.entry.entry_id,
      kind: input.kind,
      zarReversed: input.zar,
      minutesTakenBack: input.minutes,
      reason: input.reason.trim(),
      idempotencyKey: keyRef.current!.key,
    });
    keyRef.current = null;
    return { kind: "recorded", balanceAfterMinutes: r.balance_after_minutes, zarLeft: r.zar_left, minutesLeft: r.minutes_left, recovered: false };
  } catch (err) {
    if (!refusedOutright(err)) return afterLostReply(input, keyRef);
    return refused(err, keyRef);
  }
}

/** The rand typed, as a number, or a complaint. Above zero, whole cents, at most what is left. */
export function checkZar(text: string, left: number): { value: number | null; complaint?: string } {
  if (!text.trim()) return { value: null, complaint: COPY.zarMissing };
  const parsed = parseAmount(text, { max: 1_000_000 });
  if (!parsed.ok) return { value: null, complaint: COPY.zarNotCents };
  if (Math.round(parsed.value * 100) > Math.round(left * 100)) return { value: null, complaint: COPY.zarTooMuch(formatMoney(left)) };
  return { value: parsed.value };
}

/** The minutes typed, as a whole number 0..left, or a complaint. */
export function checkMinutes(text: string, left: number): { value: number | null; complaint?: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { value: null, complaint: COPY.minutesInvalid };
  const n = Number(trimmed);
  if (n > left) return { value: null, complaint: COPY.minutesTooMany(left) };
  return { value: n };
}

