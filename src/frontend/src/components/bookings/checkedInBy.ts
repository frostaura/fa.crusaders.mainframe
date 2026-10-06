import type { BookingDetail } from "@/lib/playersApi";
import { firstName } from "@/lib/playersNames";
import { standingShares } from "@/lib/standingShares";

/**
 * R19 J19-3 — whose own scan lit the court, read off the booking record. The cancel sheet said the
 * ORGANISER had checked in whenever the quote said somebody had: a partner scanned alone, and the
 * desk read "Thandi has already checked in". The quote carries no scanner, so the record answers.
 *
 * <p>
 * <b>The rule.</b> `attendance.checked_in_at` is the instant the court was lit (the money rule), and a
 * player's own scan stamps their row with that SAME instant (`SeatCheckIn.StampAsync`, the activation
 * and the late-upload reversal alike). So the player row stamped at exactly that instant lit it: a
 * partner by name, else the organiser (their seat, or a seatless game's organiser row, which reads the
 * booking's check-in only when a player lit it — R19 E19-3). Nobody stamped at that instant — a pay-for
 * payer lit it, or the record is older — is `unknown`, and the sheet names nobody rather than guess.
 * </p>
 */
export type LitBy = { kind: "organiser" } | { kind: "player"; name: string } | { kind: "unknown" };

const UNKNOWN: LitBy = { kind: "unknown" };

function instant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

export function litByOf(d: BookingDetail): LitBy {
  const at = instant(d.attendance.checked_in_at);
  if (at === null) return UNKNOWN;
  const organiserId = d.organiser.user_id;
  const lit = d.players.filter((p) => p.user_id !== null && instant(p.checked_in_at) === at);
  const partner = lit.find((p) => p.user_id !== organiserId);
  if (partner) return partner.name?.trim() ? { kind: "player", name: firstName(partner.name) } : UNKNOWN;
  return lit.length > 0 ? { kind: "organiser" } : UNKNOWN;
}

/** What the cancel sheet reads off a checked-in booking's record: the standing shares (R16 J16-7) and who lit it. */
export function checkedInRecordOf(d: BookingDetail) {
  const organiser = d.organiser.name?.trim() ? firstName(d.organiser.name) : null;
  return { status: "read" as const, shares: standingShares(d), organiser, lit: litByOf(d) };
}

/** The record while it is on its way, and when it would not read: the sheet then names nobody. */
export const RECORD_PENDING = { status: "pending" as const };
export const RECORD_FAILED = { status: "failed" as const };

export type CheckedInRecord = ReturnType<typeof checkedInRecordOf> | typeof RECORD_PENDING | typeof RECORD_FAILED;

/** A record read for one booking id — the sheet may be reopened over another. */
export type RecordFor = { id: string; record: CheckedInRecord };

/**
 * Who to name as having checked in, for a booking whose organiser is `organiserName`: the organiser
 * (`you` when the viewer IS the organiser), the partner who scanned, or null — nobody named — while
 * the record is unread, when it would not read, or when it does not say.
 */
export function checkedInName(record: CheckedInRecord, organiserName: string | null, viewerIsOrganiser: boolean): { you: boolean; name: string | null } {
  if (record.status !== "read") return { you: false, name: null };
  if (record.lit.kind === "player") return { you: false, name: record.lit.name };
  if (record.lit.kind === "unknown") return { you: false, name: null };
  return viewerIsOrganiser ? { you: true, name: null } : { you: false, name: organiserName ?? record.organiser };
}
