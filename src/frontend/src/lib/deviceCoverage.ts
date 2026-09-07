import type { AdminDevice } from "./api";

/**
 * What a court box's courts are left with when that box is out of service, and the sentences
 * the Devices screen says about it.
 *
 * <p>
 * <b>Why this is one module rather than three call sites.</b> Rounds 7, 8 and 9 each added one
 * more sentence to this screen and one more way for it to disagree with itself about number.
 * Round 8 shipped a confirm reading "Nothing else drives courts 1 and 2 … and ITS no-shows
 * stop being penalised" beside a row notice that said "their". Round 9 fixed that and shipped a
 * clause that counted COURTS while naming BOXES, so an admin with one quiet box on two courts
 * was told "the other boxes that drive them have gone quiet" — the wrong number of boxes to go
 * and look at, on the screen whose entire job is telling an admin which hardware to walk to.
 * Each of those was written at its own call site, in its own inline ternary, and each was
 * individually plausible.
 * </p>
 *
 * <p>
 * So the split and every sentence derived from it live here, together, as pure functions over
 * plain data, and {@link deviceCoverage.test.ts} runs the whole matrix — one box / many boxes ×
 * one court / many courts × shut / quiet / covered — rather than whichever corner a page test
 * happened to render. The page keeps only the liveness arithmetic it shares with the badge
 * beside the row, which it hands in as {@link ReportingPredicate}.
 * </p>
 */

/** A box's courts, split by what would still be true of them without that box. */
export type CourtCoverage = {
  /** No other box drives these while in service. Nobody can check in on them at all. */
  shut: number[];
  /** Another box in service drives these, but nothing has reported inside the threshold. */
  unattested: number[];
  /** Another box in service is reporting on these. Their no-shows are judged as normal. */
  covered: number[];
  /**
   * How many DISTINCT other boxes are in service but quiet on {@link unattested} — the boxes
   * an admin would have to walk to. Not the same number as `unattested.length`: one box drives
   * up to four courts, and up to four boxes can drive one court between them.
   */
  quietBoxes: number;
  /** How many DISTINCT other boxes are reporting on {@link covered}. Same caveat. */
  reportingBoxes: number;
};

/**
 * Is this box reporting? Supplied by the caller rather than computed here, because the answer
 * is per box against that box's own offline threshold, and it has to be the same answer the
 * "not reporting" badge two lines above the sentence is showing — one screen cannot call a box
 * quiet in its title and count it as cover in its copy.
 */
export type ReportingPredicate = (device: AdminDevice) => boolean;

/**
 * What happens to each of a box's courts if this box stops being in service.
 *
 * <p>
 * <b>The test has to be the one the money uses, and until round 9 it was a weaker one.</b>
 * `DeviceOutageIndex.CourtWasDark` calls a court dark when every ENABLED box driving it was
 * past the offline threshold at the deadline — enabled AND silent, not enabled alone. This
 * page filtered on `enabled` by itself, so a court whose only remaining box was in service but
 * had not been heard from in three hours was reported as covered. Round 8's verifier proved
 * both halves on a live stack: with the spare in service the sweep wrote CancellationRefund
 * 8.00 AND NoShowPenalty -2.40; with the spare taken out, an identical booking got the refund
 * and no penalty at all. The click DID stop that court being penalised, while the confirm
 * showed the plain "the box stops switching lights on" and the row afterwards read "Other
 * boxes still drive court 2, so its no-shows are judged as normal" — a sentence the ledger
 * had just contradicted.
 * </p>
 *
 * <p>
 * The three outcomes are kept apart because they are three different sentences, and merging
 * them would put a claim in one that is only true of another:
 * </p>
 *
 * <ul>
 *   <li><b>shut</b> — no other box drives the court while in service at all. The API refuses a
 *       disabled box 403 on every courtside endpoint, so nobody can check in there by any
 *       means. That is a door the club has closed, and it is the only branch entitled to say
 *       so.</li>
 *   <li><b>unattested</b> — another box in service does drive the court, but nothing has been
 *       heard from it for longer than the offline threshold. The settlement calls that court
 *       dark and waives the penalty; the door may well still work, and this page cannot know,
 *       so the copy says what is measurable — nothing is reporting — and not "nobody can check
 *       in".</li>
 *   <li><b>covered</b> — another box in service is reporting on the court. Its no-shows are
 *       judged as normal, which is the sentence that was false before.</li>
 * </ul>
 *
 * <p>
 * The box's own row is excluded whatever its current state, so the answer means the same thing
 * read from an enabled row ("what taking this out would strand") and from a disabled one
 * ("what is stranded now").
 * </p>
 *
 * <p>
 * The two box counts are collected here because here is the only place that can: the sentences
 * below see the split and nothing else, so a clause that names boxes has to be handed the
 * number of boxes or it will end up counting courts, which is exactly what round 9 shipped.
 * </p>
 */
export function coverageWithout(
  device: AdminDevice,
  devices: AdminDevice[],
  isReporting: ReportingPredicate,
): CourtCoverage {
  const shut: number[] = [];
  const unattested: number[] = [];
  const covered: number[] = [];
  const quiet = new Set<string>();
  const reporting = new Set<string>();
  for (const court of device.court_numbers) {
    const others = devices.filter((d) => d.id !== device.id && d.enabled && d.court_numbers.includes(court));
    const live = others.filter((d) => isReporting(d));
    if (live.length > 0) {
      covered.push(court);
      for (const d of live) reporting.add(d.id);
    } else if (others.length > 0) {
      unattested.push(court);
      // Every "other" on an unattested court is quiet by construction — `live` is empty.
      for (const d of others) quiet.add(d.id);
    } else {
      shut.push(court);
    }
  }
  return { shut, unattested, covered, quietBoxes: quiet.size, reportingBoxes: reporting.size };
}

/**
 * "court 1", "courts 1 and 3", "courts 1, 2 and 3" — courts as a sentence, without the
 * relay letters, because the consequence below is about the courts and not about which
 * output of this particular box happens to drive them.
 */
export function listCourts(courtNumbers: number[]) {
  const names = courtNumbers.map((n) => `court ${n}`);
  if (names.length === 1) return names[0];
  return `courts ${courtNumbers.slice(0, -1).join(", ")} and ${courtNumbers[courtNumbers.length - 1]}`;
}

/**
 * Singular or plural by a count.
 *
 * <p>
 * Every word on this screen that varies with number goes through this one call, and every
 * caller has to name the count it is agreeing with. That is the whole defence: the three
 * number defects this screen has shipped were all inline ternaries at a call site, and the
 * last one was wrong precisely because the count it reached for was the nearest one rather
 * than the one the words named.
 * </p>
 */
function agree(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

/** "its" / "their" — a possessive that agrees with a list of COURTS. */
export function possessive(courts: number[]) {
  return agree(courts.length, "its", "their");
}

/** "it" / "them" — the same agreement, for a COURT as an object. */
export function pronoun(courts: number[]) {
  return agree(courts.length, "it", "them");
}

/**
 * What being out of service does to this box's courts, one sentence per outcome.
 *
 * <p>
 * Shared by the row notice and the toast so the two cannot drift apart, which they had: the
 * toast said "its courts are judged by the other boxes that drive them" in the state where
 * there are none, and the notice said the same thing in different words.
 * </p>
 */
export function outOfServiceConsequences(c: CourtCoverage): string[] {
  const out: string[] = [];
  if (c.shut.length > 0) {
    // "No box in service drives …" is a negative quantifier and is correct at any number of
    // boxes, because there are none. Do not pluralise it.
    out.push(`No box in service drives ${listCourts(c.shut)}, so nobody can check in there: bookings on ${pronoun(c.shut)} are refunded in full with no no-show penalty until a box is back in service.`);
  }
  if (c.unattested.length > 0) {
    // Two independent numbers inside one clause, and keying both on one of them is the defect
    // round 9 shipped: the boxes an admin has to walk to are counted by `quietBoxes`, and the
    // courts they drive by `unattested`. One box on two courts reads "the other box that
    // drives them has gone quiet"; two boxes on one court, "the other boxes that drive it
    // have gone quiet".
    const quiet = `the other ${agree(c.quietBoxes, "box that drives", "boxes that drive")} ${pronoun(c.unattested)} ${agree(c.quietBoxes, "has", "have")} gone quiet`;
    out.push(`Nothing in service is reporting on ${listCourts(c.unattested)} — ${quiet} — so bookings on ${pronoun(c.unattested)} are refunded in full with no no-show penalty until one calls in again.`);
  }
  if (c.covered.length > 0) {
    // Same trap on the reassuring branch, and it was live too: this named boxes in the plural
    // whatever the count, so the commonest shape in a small club — one spare still reporting —
    // told an admin there were several.
    out.push(`${agree(c.reportingBoxes, "Another box is", "Other boxes are")} still reporting on ${listCourts(c.covered)}, so ${possessive(c.covered)} no-shows are judged as normal.`);
  }
  return out;
}

/**
 * The confirm label for "Take out of service".
 *
 * <p>
 * It names the consequence that is hardest to undo knowing about, and only the ones that are
 * true of this box: an admin taking a spare out beside a reporting box gets the plain
 * sentence, because for them none of the rest is true. It also agrees with itself — the row
 * notice pluralised "its" and this label did not, so a two-court box confirmed with "Nothing
 * else drives courts 1 and 2 — nobody can check in there and ITS no-shows stop being
 * penalised."
 * </p>
 */
export function outOfServiceConfirm(c: CourtCoverage): string {
  const parts: string[] = [];
  if (c.shut.length > 0) {
    parts.push(`Nothing else drives ${listCourts(c.shut)} — nobody can check in there and ${possessive(c.shut)} no-shows stop being penalised.`);
  }
  if (c.unattested.length > 0) {
    // "No other box … is reporting" is a negative quantifier and stays singular however many
    // boxes are quiet, the same way "no box in service drives …" does above. So this is the
    // one clause here whose "box" must NOT be pluralised on `quietBoxes` — pinned as such,
    // because the round that fixes the next positive clause will be looking straight at it.
    parts.push(`No other box on ${listCourts(c.unattested)} is reporting, so ${possessive(c.unattested)} no-shows stop being penalised${c.shut.length > 0 ? " too" : ""}.`);
  }
  return parts.length === 0
    ? "Out of service? The box stops switching lights on."
    : `Out of service? ${parts.join(" ")}`;
}
