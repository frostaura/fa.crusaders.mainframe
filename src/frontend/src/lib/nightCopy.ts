import { clubClock, clubDate } from "./clubClock";
import type { TraceActor, TraceView } from "./adminApi";

/**
 * Every sentence on a person's night, and on the club's own change record.
 *
 * <p>
 * <b>This is the most privacy-consequential surface in the product, and the copy is where
 * that is either honoured or quietly lost.</b> The doors contract says the club keeps no
 * attendance record; `GOAL.md` supersedes it for THIS surface only, deliberately, and names
 * the three things that make the exception survivable: admin-only, retention-bound, and an
 * audit of who looked. Two of those are the server's. The third is a sentence, and it is
 * here.
 * </p>
 *
 * <p>
 * <b>Nothing in this module paints an event.</b> The server composes each `headline` from a
 * closed vocabulary, for the reason the doors console proves: it held its own dictionary,
 * the server's vocabulary moved, and a door with thirteen admin edits rendered "13 refused
 * scans". What is written here is the FRAME — who did it, what a gap means, what an
 * approximate time means, and what looking at this page costs.
 * </p>
 */

// ---------------------------------------------------------------------------------------
// The standing notice, which is the whole of the privacy exception
// ---------------------------------------------------------------------------------------

export const NIGHT_PRIVACY_NOTICE
  = "This shows one member's movements in the club. Opening it is recorded — your name, their "
  + "name, and the night you looked at — and they can ask to see that record. It is here to "
  + "settle a question: a disputed charge, a door that did not open, a light that did not come "
  + "on. It is not here to browse.";

/**
 * And the other half, which most designs leave out: what happens when the read FAILS.
 *
 * The server writes its audit row on a 200. If the page said "opening it is recorded" and
 * then failed, the notice above would be a lie about the one thing this surface promises.
 */
export const NIGHT_READ_FAILED
  = "Couldn't read that night. Nothing was recorded about this look-up, because the club's "
  + "system never answered.";

export const NIGHT_EXPORT_NOTE
  = "The download has the member's name in it, and it writes another line in the change record "
  + "saying you took it. Once it is on your computer it is outside the club's own rules about "
  + "how long any of this is kept.";

/** A night's window, said plainly, because "a night" is not a self-evident unit. */
export function nightWindowHint(range: TraceView["range"], timezone: string | undefined): string {
  if (!range) return "Pick a night. Everything the club recorded about that member on that day appears below.";
  return `From ${clubClock(range.from, timezone)} to ${clubClock(range.to, timezone)} club time, on ${clubDate(range.from, timezone)}.`;
}

// ---------------------------------------------------------------------------------------
// Actor versus subject — the spine of the design
// ---------------------------------------------------------------------------------------

/**
 * "by Thandi herself" · "by Review Admin" · "by the club".
 *
 * <p>
 * <b>`kind` is the server's, and it is not "the actor is not the subject".</b> That
 * conflation is a recorded backend defect: it makes every automatic no-show sweep claim an
 * admin did it. `system` is a real state — `Guid.Empty` is what the no-show worker actually
 * writes — and a system row says so in words, which is the sentence a member disputing a
 * penalty is entitled to.
 * </p>
 *
 * <p>
 * Returns `null` where the payload says nothing about who acted, so a card renders no clause
 * rather than "by undefined" or, worse, a guess.
 * </p>
 */
export function actorClause(actor: TraceActor | null | undefined, subjectName: string): string | null {
  if (!actor) return null;
  if (actor.kind === "system") return "by the club's own automatic check";
  if (actor.kind === "device") return "at a board, with nobody signed in";
  const name = (actor.name ?? "").trim();
  if (actor.is_self === true) {
    // "by Thandi herself" needs a first name and a pronoun this product does not hold. The
    // member's own name plus "themselves" is the version that is true of everybody.
    return `by ${subjectName} themselves`;
  }
  if (name === "") return null;
  return actor.kind === "admin" ? `by ${name}, an admin` : `by ${name}`;
}

/** True when this row is somebody acting ON the traced member — the thing worth seeing. */
export function isOnBehalf(actor: TraceActor | null | undefined): boolean {
  if (!actor) return false;
  if (actor.is_self === true) return false;
  return actor.kind === "admin" || actor.kind === "member";
}

// ---------------------------------------------------------------------------------------
// Gaps and approximate times
// ---------------------------------------------------------------------------------------

/**
 * "1h 04m — nothing recorded".
 *
 * Those words, and not "no activity". *Nothing was recorded* and *nothing happened* are
 * different claims, and a box that was offline, a door row past its ninety days and a scan
 * that never uploaded all produce the first without being evidence of the second.
 */
export function gapLine(duration: string): string {
  return `${duration} — nothing recorded`;
}

export const APPROXIMATE_EXPLANATION
  = "A time marked ≈ came from the board's own clock, because the board was offline when it "
  + "happened and uploaded it later. It may be a few minutes out.";

// ---------------------------------------------------------------------------------------
// Retention, both horizons, both said
// ---------------------------------------------------------------------------------------

/**
 * What might be missing from this night, and why — or `null` when nothing is.
 *
 * <p>
 * Audit and ledger rows live to `retention_years`; DOOR rows are deleted at
 * `door_log_retention_days`, which is much shorter. Asking for a night 120 days back must
 * not return an empty door strand that reads as "she was not here". The flag the server
 * sends says "may be", which is the only claim the data supports, and this sentence keeps
 * that word.
 * </p>
 */
export function retentionCaveat(retention: TraceView["retention"], timezone: string | undefined): string | null {
  if (!retention) return null;
  if (retention.door_rows_may_be_incomplete !== true) return null;
  const horizon = retention.door_horizon
    ? ` The club keeps door scans back to ${clubDate(retention.door_horizon, timezone)}.`
    : "";
  const days = retention.door_days ? ` after ${retention.door_days} days` : "";
  return `Door scans from this night may already have been deleted${days}, so the doors part of `
    + `this page may be incomplete. That is not evidence that nobody came in.${horizon}`;
}

// ---------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------

export function nightEmptyNotice(name: string, date: string): string {
  return `Nothing was recorded for ${name} on ${date}.`;
}

export const NIGHT_EMPTY_HINT
  = "Boxes and doors that were offline that night may not have uploaded yet — it is worth "
  + "looking again tomorrow.";

export const NIGHT_NO_MEMBER_YET = "Pick a member first. There is nothing to show until you do.";

// ---------------------------------------------------------------------------------------
// The admin change record
// ---------------------------------------------------------------------------------------

/**
 * What the change record IS, in the words that are actually true of it.
 *
 * <p>
 * <b>The claim is deliberately narrower than "tamper-proof".</b> D2 §11.6 builds four layers
 * — no delete path in the code, a trigger that raises on UPDATE, DELETE and TRUNCATE, a
 * REVOKE, and exemption from the retention worker — and then states the residual: the REVOKE
 * only means anything if the runtime connects as a role that is not the table's owner, and
 * today the application runs its own migrations, so it almost certainly is the owner. An
 * owner can disable a trigger.
 * </p>
 *
 * <p>
 * So the sentence says what the software can guarantee — nobody can delete these from the
 * app, including an admin, including the club owner — and does not say the other thing.
 * Pretending otherwise about an audit trail is worse than not having one, because the club
 * would rely on it.
 * </p>
 */
export const CHANGES_STANDING_NOTICE
  = "Everything an admin does that affects a member or a court, in the order it happened. "
  + "Nobody can delete these from the app, including admins and including the club's owner: "
  + "there is no delete anywhere in the software, and the database refuses one outright.";

export const CHANGES_EMPTY = "No changes recorded in this range.";
export const CHANGES_READ_FAILED
  = "Couldn't read the change record. That does not mean nothing happened — it means the club's "
  + "system did not answer.";

/** A row whose writer predates the before/after convention. An honest gap, not a blank. */
export const CHANGES_NO_DIFF = "What changed wasn't recorded for this row.";

export const CHANGES_EXPORT_NOTE
  = "The download has members' names in it. Once it is on your computer it is outside the "
  + "club's own rules about how long any of this is kept.";
