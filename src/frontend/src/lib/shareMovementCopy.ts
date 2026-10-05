import { minutesSpoken } from "./minutes";
import { firstName } from "./playersNames";
import { courtOf, plainMovementSentence, sharePlace, type SharePlace } from "./walletCopy";

/*
 * The words for ONE share movement — a ledger line's sentence and the chip's share toast (D11, R11–R14).
 *
 * Out of `walletCopy` (R14, entry budget): the chip is in the entry chunk, and these sentences are
 * only ever said once a share has moved — the wallet page (lazy) and the chip's share toast, which
 * loads them with `components/shell/shareMovement` on the first share frame. Kept out of every
 * static import of `main.tsx` (entryGraph.test).
 */

export type ShareRowInput = {
  side: "organiser" | "partner";
  signed: number;
  place: SharePlace;
  /** The other person on this movement — the organiser for a partner, a partner for the organiser. */
  other: string | null;
  /** R11 E11-1 — the live frame's `share_cause`; absent on a ledger row (the row stores none). */
  cause?: string | null;
  /** R11 E11-1 — with `no_show`: the partner's part of the penalty that did not come back. */
  kept?: number | null;
  /** R12 E12-2 (contract C2) — with `attended`: who checked in, when it was not this member. */
  by?: string | null;
  /** R13 X13-3 — with `booking_cancelled`: the frame's `cancelled_by` ("club": the club cancelled it). */
  cancelledBy?: "club" | "member";
  /** R14 (BE14b §2) — the frame's `actor_name`: the player whose act moved the share, when not this member. */
  actor?: string | null;
  /**
   * R15 J15-5 — a toast names the day too ("Court 4 · Sat 17 Oct"): it stands alone. A ledger line
   * under its group's heading (which says court, day and time) keeps the court alone.
   */
  dated?: boolean;
};

/**
 * One share movement, as a sentence. "25 min moved to Nomsa for your share of Court 1".
 * Nobody owes anybody: a partner's share MOVES, and a returned one COMES BACK.
 *
 * <p>
 * R11 E11-1 — with the live frame's `share_cause` the sentence says WHY, in the inbox's words:
 * "… came back — the club refunded the session: the court's box was offline", a no-show's return
 * with the partner's part of the penalty, a late check-in's "taken again — the session was
 * attended". An unknown cause (a newer server) says today's sentence.
 * </p>
 */
export function shareRowSentence(input: ShareRowInput): string {
  const amount = minutesSpoken(Math.abs(input.signed));
  const court = (input.dated ? sharePlace(input.place) : null) ?? courtOf(input.place);
  const who = personName(input.other);
  const acted = input.cause ? actedShareSentence({
    side: input.side, signed: input.signed, cause: input.cause, cancelledBy: input.cancelledBy,
    actor: personName(input.actor), other: who, others: who ? [who] : [], where: sharePlace(input.place),
  }) : null;
  if (acted) return acted;
  const clause = shareCauseClause(input, who);
  if (input.cause === "attended" && input.side === "partner" && input.signed < 0) {
    return `${amount} taken again for your share of ${court}${clause}`;
  }
  if (input.side === "partner") {
    if (input.signed < 0) return `${amount} moved to ${who ?? "the organiser"} for your share of ${court}${clause}`;
    return `${amount} of your share of ${court} came back${clause || (who ? ` from ${who}` : "")}`;
  }
  if (input.signed >= 0) return `${who ?? "A partner"} paid you ${amount} for their share of ${court}${clause}`;
  return `${amount} went back to ${who ?? "a partner"} from their share of ${court}${clause}`;
}

type Acted = {
  side: "organiser" | "partner"; signed: number; cause: string; cancelledBy?: "club" | "member";
  /** First names: who acted (the frame's `actor_name`), and the other person on the share. */
  actor: string | null; other: string | null;
  /** R14 §9 — every partner the frame's share rows name (first names), for a return to two at once. */
  others: readonly string[];
  /** "Court 3 · Mon 5 Oct", or null when the booking cannot be placed. */
  where: string | null;
};

/**
 * R14 X14-2 / E14-1 (BE14b contract) — a share that went back because somebody ACTED, said as the
 * act, by name: "Omar took you off Court 3 · Mon 5 Oct — 7 minutes came back"; "Otto changed the
 * split on …"; "Sam withdrew from … — 7 minutes went back to them"; a member cancel "Omar cancelled
 * … — 7 minutes of your share came back". `share_returned` is only ever a withdrawal now; the
 * organiser's removal and a lowered split are their own causes. Null: not one of these.
 */
function actedShareSentence(a: Acted): string | null {
  if (a.side === "partner" && a.signed > 0) return partnerActed(a, minutesSpoken(a.signed), a.where ?? "the game");
  if (a.side === "organiser" && a.signed < 0) return organiserActed(a, minutesSpoken(-a.signed), a.where ?? "the game");
  return null;
}

/** The partner's side: their share came back, and who did what to make it. */
function partnerActed(a: Acted, minutes: string, where: string): string | null {
  const by = a.actor ?? a.other ?? "The organiser";
  const said: Record<string, () => string | null> = {
    organiser_removed: () => `${by} took you off ${where} — ${minutes} came back`,
    split_changed: () => `${by} changed the split on ${a.where ?? "your game"} — ${minutes} came back`,
    share_returned: () => `You withdrew from ${where} — ${minutes} came back`,
    club_removed: () => `The club took you off ${where} — ${minutes} came back`,
    booking_cancelled: () => (a.cancelledBy === "member" && a.actor ? `${a.actor} cancelled ${where} — ${minutes} of your share came back` : null),
    // R14 §9 — the club recorded the share as paid outside the app; a return no record explains names nobody.
    club_settled: () => `${minutes} of your share of ${a.where ?? "a split booking"} came back — the club recorded your share as paid outside the app`,
    share_back: () => `${minutes} of your share of ${a.where ?? "a split booking"} came back`,
  };
  return said[a.cause]?.() ?? null;
}

/** The organiser's side: a partner's share went back to them. */
function organiserActed(a: Acted, minutes: string, where: string): string | null {
  const partner = a.other ?? a.actor;
  // R14 §9 — the record's own cause, naming only whom the minutes went back to: never who did it.
  const many = a.others.length > 1;
  const to = a.others.length > 0 ? listed(a.others) : "a partner";
  const share = many ? "their shares" : "their share";
  const of = a.where ?? "a split booking";
  const said: Record<string, () => string> = {
    club_settled: () => `${minutes} went back to ${to} — the club recorded ${share} of ${of} as paid outside the app`,
    share_back: () => `${minutes} went back to ${to} from ${share} of ${of}`,
    share_returned: () => `${a.actor ?? partner ?? "A partner"} withdrew from ${where} — ${minutes} went back to them`,
    organiser_removed: () => `You took ${partner ?? "a partner"} off ${where} — ${minutes} went back to them`,
    split_changed: () => `You changed the split on ${a.where ?? "your game"} — ${minutes} went back to ${partner ?? "your partner"}`,
    club_removed: () => `The club took ${partner ?? "a partner"} off ${where} — ${minutes} went back to them`,
  };
  return said[a.cause]?.() ?? null;
}

/** Why a share moved, as a trailing clause (" — the booking was cancelled"); "" for none or unknown. */
function shareCauseClause(input: ShareRowInput, who: string | null): string {
  const partner = input.side === "partner";
  const kept = input.kept ?? 0;
  const keptPart = kept > 0
    ? `, and ${minutesSpoken(kept)} ${kept === 1 ? "is" : "are"} ${partner ? "your" : `${who ?? "the partner"}'s`} part of the no-show penalty`
    : "";
  const clauses: Record<string, string> = {
    outage_refund: "the club refunded the session: the court's box was offline",
    displaced: "the club refunded the session: the court was already in use by an earlier booking",
    // R13 X13-3 — the partner was told only "the booking was cancelled" when the club did it.
    booking_cancelled: input.cancelledBy === "club" ? "the club cancelled the booking" : "the booking was cancelled",
    club_removed: partner ? "the club took you off the game" : "the club took them off the game",
    club_collected: "the club collected it",
    attended: input.by ? `${input.by} checked in, so the session was attended` : "the session was attended",
    // R12 X12-3 — a partner withdrew, and their share went back to them.
    share_returned: partner ? "you withdrew from the game" : `${who ? "they" : "the partner"} withdrew from the game`,
    no_show: `nobody checked in${keptPart}`,
  };
  const said = input.cause ? clauses[input.cause] : undefined;
  return said ? ` — ${said}` : "";
}

/**
 * R11 E11-1 — the chip's plain share sentence (no booking to name) with the frame's cause:
 * "A share of a split booking moved 15 minutes into your wallet — the booking was cancelled."
 *
 * <p>
 * R13 J13-4 / X13-3 — a share that came back to a PARTNER (a known return cause) says it was theirs
 * and why: "10 minutes of your share of Court 1 came back — the club took you off the game". The
 * court comes from `more.place` (the frame's own, when the booking can no longer be read — a member
 * taken off it), else "a split booking"; `more.cancelledBy` says whether the club cancelled.
 * </p>
 */
export function shareMovementPlain(
  amount: number, cause: string | undefined, kept: number | undefined, by?: string,
  more: { cancelledBy?: "club" | "member"; place?: SharePlace; actor?: string; other?: string | null; others?: readonly (string | null | undefined)[] } = {},
): string {
  // A collection (paid, collected, taken again) leaves the PARTNER; a return comes back to them.
  const collected = cause === "share_paid" || cause === "club_collected" || cause === "attended";
  const side = (collected ? amount < 0 : amount > 0) ? "partner" : "organiser";
  // R14 X14-2 — a removal, a split change, a withdrawal or a member's cancel: said as the act.
  const acted = cause ? actedShareSentence({
    side, signed: amount, cause, cancelledBy: more.cancelledBy, actor: personName(more.actor),
    other: personName(more.other), where: sharePlace(more.place),
    others: [...new Set((more.others ?? [more.other]).map(personName).filter((n): n is string => n !== null))],
  }) : null;
  if (acted) return `${acted}.`;
  const row = { side, signed: amount, place: more.place ?? null, other: null, cause, kept, by, cancelledBy: more.cancelledBy } as const;
  if (cause && side === "partner" && amount > 0) {
    // R13 J13-4 (C13-7) — the court and the day from the frame: "of your share of Court 1 · Tue 8 Oct".
    const where = sharePlace(row.place) ?? "a split booking";
    return `${minutesSpoken(amount)} of your share of ${where} came back${shareCauseClause(row, null)}.`;
  }
  const clause = shareCauseClause(row, null);
  // R15 J15-5 — placed by the frame: the court and the day ("for a share of Court 4 · Sat 17 Oct").
  const where = sharePlace(row.place);
  if (where) {
    const m = minutesSpoken(Math.abs(amount));
    const placed = side === "organiser"
      ? (amount > 0 ? `${m} came in for a share of ${where}` : `${m} went back from a share of ${where}`)
      : (amount < 0 ? `${m} went on your share of ${where}` : `${m} of your share of ${where} came back`);
    return `${placed}${clause}.`;
  }
  const plain = plainMovementSentence(amount, "share_transfer");
  return clause ? `${plain.replace(/\.$/, "")}${clause}.` : plain;
}

/**
 * A person's first name for a sentence, or null for nobody. R14 §9 — a member's wallet says "The
 * club" for an admin, which is never cut to "The"; a blank name is nobody, never "" or "null".
 */
function personName(name: string | null | undefined): string | null {
  const said = name?.trim() ?? "";
  if (said === "" || said === "null") return null;
  return /^the club$/i.test(said) ? "The club" : firstName(said);
}

/** "a", "a and b", "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

