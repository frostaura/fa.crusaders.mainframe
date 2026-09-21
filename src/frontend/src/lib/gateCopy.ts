import { type GateAccessPolicy } from "./api";

/**
 * Everything the console says about a door gate, in one place.
 *
 * <p>
 * <b>Why a module rather than four inline strings.</b> The court-box half of this screen
 * learned it the expensive way: the out-of-service consequence was written three times at
 * three call sites — the confirm label, the row notice and the toast — and shipped three
 * rounds running with the three of them disagreeing about what the click had just done.
 * The fix was {@link deviceCoverage}, one generator feeding all of them. A door arrives
 * with exactly the same shape (a confirm, a notice, a toast, all promising one thing) and
 * there is no reason to rediscover the lesson at a lower price.
 * </p>
 *
 * <p>
 * <b>And because a door's copy cannot be inherited from a box's.</b> Every sentence the
 * box side says about being out of service is about courts going dark and no-show
 * penalties being waived, and NONE of it is true of a door: a gate decision never touches
 * a booking, a `CheckedInAt`, the ledger or the no-show sweep — walking through a door is
 * not attendance. Reusing that copy on a gate row would have been a screen telling a club
 * its refunds had changed when nothing of the sort happened.
 * </p>
 */

/** Mirrors the API's `gate_key` column — `HasMaxLength(64)`, trimmed, `""` stored as null. */
export const GATE_KEY_MAX_LENGTH = 64;

/**
 * Mirrors `Device.Name` — `HasMaxLength(128)` in `MainframeDbContext`.
 *
 * <p>
 * <b>A2 / B2 / R3-15: it was nowhere, and that is exactly what it cost.</b> The form had no
 * bound on the field, the API had no check, and a 129-character name reached the database as
 * a `DbUpdateException` that came back to the browser as a 500 with the EF exception in it.
 * The number lives here for the same reason {@link GATE_KEY_MAX_LENGTH} does: the field that
 * stops it, the sentence that explains it and the test that pins it must all be the SAME 128,
 * and a screen that guesses the column's bound is a screen that drifts from it silently.
 * </p>
 *
 * <p>
 * It is a device column rather than a gate one — a court box's name is bound identically —
 * and it sits in this module because the door editor is the only form that enforces it today.
 * </p>
 */
export const DEVICE_NAME_MAX_LENGTH = 128;

/**
 * How many bookings a door's offline roster holds.
 *
 * <p>
 * `Roster<48>` on the board (`gatelogic/GateConfig.h`'s `kGateRosterEntries`), and the API
 * cuts to the same 48 after ordering by `StartsAt` then `Id` — so it is the LATEST-STARTING
 * bookings that are left out, not a random 48. Named here because the settings copy states
 * the number, and a copy module that spells a number the firmware owns is a number that
 * drifts.
 * </p>
 */
export const GATE_ROSTER_MAX_ENTRIES = 48;

/**
 * What a door with no name is called.
 *
 * A gate self-registers with `GateKey = null`, so every door in the club arrives looking
 * identical and the row has to say which state that is. "—" or an empty gap reads as a
 * rendering fault; this reads as a job.
 */
export const UNNAMED_GATE = "no door name yet";

/** The identity line's gate half: `Door gate · front-door`, or the unnamed state. */
export function describeGate(gateKey: string | null): string {
  return `Door gate · ${gateKey ?? UNNAMED_GATE}`;
}

/**
 * The badge a freshly self-registered door wears.
 *
 * <p>
 * The court-box badge says "New — check court numbers", which is the right job for a box
 * and is meaningless on a door: a gate registers with `CourtNumbers = []` and the API
 * refuses court numbers on it outright. What a new door actually needs is a name, because
 * there is one firmware for every door, nothing per-gate is compiled in, and until somebody
 * names it the audit rows for every scan at it carry a null `gate_key` — leaving the door
 * identified by its `device_code` alone, which is `gate-` plus six hex digits of a MAC.
 * </p>
 */
export const NEW_GATE_BADGE = "New — name this door";

/**
 * What an unnamed door cannot do, said wherever the unnamed state is visible.
 *
 * <p>
 * A heartbeat for a Gate row whose `GateKey` is null answers `roster: []` — the key is
 * present and empty. Online scans work from the moment the board is plugged in, so the
 * install stays plug-and-play; the OFFLINE fallback is what does not exist until an admin
 * has named the door. The reason is not tidiness: anybody holding the club's one device key
 * can self-register a "gate" with a random MAC, and before this that handed them the
 * club-wide code set on demand. Naming the door is the admin's acknowledgement that the
 * board is theirs.
 * </p>
 *
 * <p>
 * It is keyed on the NAME being absent rather than on the "New" badge, which fires on
 * `auto_registered`. Those two states overlap and are not the same one: an admin who clears
 * a door's name has taken its roster away again, and a row that has been edited for some
 * other reason no longer carries the badge while still having no name.
 * </p>
 */
export function unnamedGateOfflineNotice(): string {
  return "Until you name this door it only works while it can reach the server: an unnamed door is"
    + " sent an empty list, so it opens nothing at all while it is offline.";
}

/**
 * What taking a door out of service actually does, as the row notice and the toast both
 * say it.
 *
 * <p>
 * Three clauses, and the middle one is the clause a shorter sentence would have got wrong.
 * </p>
 *
 * <ol>
 *   <li><b>The API stops answering.</b> `DeviceIdentity.ResolveAsync` answers 403 for
 *       `!device.IsActive` on every `/api/v1/device/` route, and `/device/gate` is one of
 *       them, so from the instant the switch is thrown the server opens nothing at this
 *       door.</li>
 *   <li><b>Whether the door still opens depends on whether it can hear the refusal.</b>
 *       This is the half worth being honest about, and it is a pair of halves rather than
 *       one. A 403 is now AUTHORITATIVE for a gate: a board that reaches the API and is
 *       refused denies the scan outright with no roster fallback, and a 403 on its
 *       heartbeat commits an empty roster — so a door that is merely out of service, on a
 *       working network, opens for nobody from the instant the switch is thrown. A board
 *       that has ALSO lost the network never hears any of that. Every other failure
 *       (401/404/408/429/5xx/0/malformed) still falls back to the roster it last
 *       downloaded, so a cut-off door keeps admitting members with a booking in that cache
 *       until it goes stale at six hours. Saying "the door stops opening" flatly would be
 *       the same class of falsehood as the box side's "nobody can check in there", which
 *       survived three rounds; saying only the cached-roster half is now the opposite
 *       falsehood, and would have been true copy before this round.</li>
 *   <li><b>No money moves.</b> A gate decision never writes a booking, a `CheckedInAt`, a
 *       ledger entry or a settlement row, online or from the roster. That is worth stating
 *       rather than leaving out, because the identical control one row above — on a court
 *       box — waives no-show penalties on a whole court, and an admin who has read that
 *       notice has every reason to assume this one does something similar.</li>
 * </ol>
 *
 * <p>
 * <b>Renamed from `gateOutOfServiceNotice`, and its last clause rewritten (A1.1, A1.4).</b>
 * Two changes, one reason each. The NAME: `/admin/devices` shipped this same PATCH behind a
 * button reading "Take out of service", and a volunteer who shuts a door from one screen and
 * cannot find how to reopen it from another is the whole cost of two names for one
 * mechanism — so a door is "shut" and "reopened" everywhere, and a court box keeps "out of
 * service", where it means something else entirely. The CLAUSE: it used to end "Bookings,
 * check-ins, refunds and no-show penalties are untouched either way: opening a door is not
 * attendance", which carries two words the doors programme bans outright — in the negative,
 * which is the only reason an admin ever learns that a door scan is not a court arrival.
 * Read literally the ban deletes the denial and leaves the inference it was written to kill,
 * so the ruling is that the ban is on the CLAIM and the clause is rewritten rather than
 * dropped. Everything else here is character-for-character what it was, because it was
 * already right and already pinned.
 * </p>
 */
export function doorShutNotice(): string {
  // <b>B4 / R3-24 — it opened "The club is not alerted about its silence…".</b> Under a
  // heading reading "Shutting or removing this door" that sentence has no subject a reader
  // can attach it to: "its" is a door nobody has mentioned yet, and the first thing a
  // volunteer met on the block was a clause about ALERTS, which is not what the block is
  // about. It is also stated as an unconditional fact about the club when it is a
  // consequence of shutting — so it is said second, in full, and with its subject.
  return "Shutting a door refuses every scan at it from the instant the switch is thrown, at the"
    + " club's server. A shut door is expected to be quiet, so the club stops raising its silence"
    + " as a fault while it is shut. A door that can still reach the club hears"
    + " that refusal and opens for nobody, with no fall back to its saved list. A door that has also"
    + " lost the network never hears it, and keeps admitting members with a booking from the list it"
    + " last downloaded until that goes stale, which takes up to six hours. Bookings, refunds and"
    + " no-show penalties are untouched either way, and a door marks nobody as having arrived.";
}

/**
 * The one name for the 403 path on a gate, on every screen that offers it (A1.4).
 *
 * A court box keeps "Take out of service": there the same switch darkens courts and waives
 * no-show penalties, which is a different consequence and deserves a different word.
 */
export const DOOR_SHUT_LABEL = "Shut this door";
export const DOOR_REOPEN_LABEL = "Reopen this door";

// --- B3 / B5 / C2: what an armed control says, generated from the door's situation -----

/**
 * The door's ACTUAL situation — the only input any armed consequence is written from.
 *
 * <p>
 * <b>B3, and it is the finding this whole section exists for.</b> Every confirm on this
 * surface described the PAIR in the abstract — "a door that can reach the club … one that has
 * also lost the network …" — so a door that is in contact was told about doors that are not,
 * and, far worse, a door that <b>has never been named</b> was told it "keeps admitting booked
 * members from the list it last downloaded". An unnamed gate is sent an EMPTY list: it opens
 * for nobody while it is offline, and the screen said the opposite on the control that shuts
 * it. One function, one matrix test, and no call site that can choose its own words.
 * </p>
 *
 * <p>
 * <b>And B5: ≤25 words, always.</b> The armed fleet confirm was 45 words inside an 8-second
 * auto-disarm, which a screen reader takes ~13 seconds to read. There is no timer any more
 * (the chrome lane owns that), but a consequence nobody finishes reading is still a
 * consequence nobody read. The long explanation is plain page text beside the control, where
 * it can be as long as it needs to be.
 * </p>
 */
export type DoorSituation = {
  /** Can the club reach this door right now? The first question, and it settles most of them. */
  online: boolean;
  /**
   * Has it a door name — which is to say, is it sent a list at all?
   *
   * A heartbeat for a gate whose `GateKey` is null answers `roster: []`. "Keeps admitting
   * booked members" is flatly false of such a door, and that is the sentence that shipped.
   */
  named: boolean;
  /**
   * <b>Has this SHUT door been told? R3-1's third input, and it outranks `online`.</b>
   *
   * <p>
   * `true` where the server has served this board a 403 since the shut began — which means
   * the board denied the scan outright and committed an empty roster, so it opens for nobody
   * whatever its network has done since. `false` where the server says it has not called.
   * <b>`undefined` where the API cannot say</b>, which is the arm every sentence below used
   * to take while asserting one of the other two.
   * </p>
   *
   * <p>
   * It matters most on REOPEN: "It has been admitting booked members from its saved list all
   * along" is the exact opposite of the truth for a door that heard the shut, and that is the
   * sentence an admin read on the control they were about to press.
   * </p>
   */
  heardShut?: boolean;
};

/** Six hours, said once, in the words every arm uses. */
const CACHE_CLAUSE = "keeps admitting booked members from its saved list for up to six hours";

/**
 * What shutting THIS door does, in ≤25 words.
 *
 * Three arms and no pair-in-the-abstract: a door in contact hears the refusal and that is the
 * whole answer for it; a named door that cannot hear keeps its cached list; an unnamed one
 * has no list to keep.
 */
export function doorShutConsequence(door: DoorSituation): string {
  if (door.online) return `${DOOR_SHUT_LABEL}? It hears this at once and opens for nobody.`;
  if (door.named) return `${DOOR_SHUT_LABEL}? Nothing can reach it, so it ${CACHE_CLAUSE}.`;
  return `${DOOR_SHUT_LABEL}? Nothing can reach it, and with no saved list it already opens for nobody.`;
}

/**
 * What reopening THIS door does — the same three arms, inverted.
 *
 * C5's fix generalised: "from the very next scan" is a promise about a machine that is
 * listening, and only the first arm's door is.
 */
export function doorReopenConsequence(door: DoorSituation): string {
  // R3-1, and it is checked FIRST because it is the fact that settles the question. A door
  // that heard the shut threw its list away, so it has been admitting NOBODY — the opposite
  // of what the `named && !online` arm below said to every such door.
  if (door.heardShut === true) {
    return `${DOOR_REOPEN_LABEL}? It was told of the shut and has been opening for nobody. It opens`
      + " for members again from its next call in.";
  }
  if (door.online) return `${DOOR_REOPEN_LABEL}? It opens for members again from the very next scan.`;
  if (door.named) {
    // `heardShut === false` is the server saying it never called; `undefined` is an API that
    // cannot say. The first states the cache flatly, the second hedges it — and neither is
    // allowed to state it as a certainty derived from an age, which is what shipped.
    const cache = door.heardShut === false
      ? "It has been admitting booked members from its saved list all along."
      : "It may have been admitting booked members from its saved list all along.";
    return `${DOOR_REOPEN_LABEL}? Nothing can reach it. ${cache}`;
  }
  return `${DOOR_REOPEN_LABEL}? Nothing can reach it, and with no saved list it opens for nobody until`
    + " it calls in.";
}

/**
 * The confirm label for shutting a door. Kept as a name for the call sites; the words are
 * {@link doorShutConsequence}'s.
 */
export function doorShutConfirm(door: DoorSituation): string {
  return doorShutConsequence(door);
}

export function doorReopenConfirm(door: DoorSituation): string {
  return doorReopenConsequence(door);
}

/** "all 4 doors" · "the club's one door" — never "all 1 doors". */
function allDoors(count: number): string {
  return count === 1 ? "the club's one door" : `all ${count} doors`;
}

/**
 * Shutting every door at once, confirmed.
 *
 * <p>
 * It is one unit of work at the server (W1.5), which is what makes "every door … from this
 * click" true rather than "some of them, probably". The cut-off half is the same caveat one
 * door carries, said of the fleet — and it is the half that makes a club-wide shut worth a
 * per-door result screen instead of a toast.
 * </p>
 */
export function doorFleetShutConfirm(
  count: number, unreachable: DoorSituation[] = [], total = count,
): string {
  // <b>B6 / C-L2 / R3-23.</b> "Shut all 2 doors?" over a club of three is false twice: it is
  // not all of them, and a reader who has one door already shut is being told the control
  // reaches every door the club has. The idle label has counted what is still open since C1;
  // the confirm — the sentence somebody commits on — had not caught up.
  const head = total > count
    ? `Shut the ${count} ${count === 1 ? "door" : "doors"} still open?`
    : `Shut ${allDoors(count)}?`;
  // B3, at fleet scale. The old sentence described every door as both reachable and cut off
  // at once. The doors this club actually has are countable, so the confirm counts them.
  if (unreachable.length === 0) return `${head} Every one of them opens for nobody from this click.`;
  const listed = unreachable.filter((d) => d.named).length;
  const missed = `${unreachable.length} cannot be reached`;
  const opens = unreachable.length === 1 ? "it opens" : "they open";
  if (listed === 0) return `${head} ${missed}, and with no saved list ${opens} for nobody anyway.`;
  // "for six hours" rather than the per-door clause's "for up to six hours": the fleet head
  // is longer, and B5's bound is 25 words for the whole sentence, not per clause.
  const some = listed === unreachable.length ? "" : `${listed} of them `;
  const admit = listed === 1
    ? "keeps admitting booked members from its saved list"
    : "keep admitting booked members from their saved lists";
  return `${head} ${missed} and ${some}${admit} for six hours.`;
}

/**
 * Reopening the doors the club shut TOGETHER. Same inversion as {@link doorReopenConfirm}.
 *
 * <p>
 * C1: the count is the number this request will actually reopen, never the club's total, and
 * any door that will stay shut is named in the same breath — the previous label read "Reopen
 * all 3" over a request that reopened none of them.
 * </p>
 */
export function doorFleetReopenConfirm(count: number, unreachable: DoorSituation[] = []): string {
  const head = count === 1
    ? "Reopen the one door that was shut together?"
    : `Reopen the ${count} doors that were shut together?`;
  // B5: the doors that stay shut are NAMED beside the control as page text
  // ({@link doorsStayShutNotice}), not folded into the armed consequence — the fleet confirm
  // was 45 words inside an 8-second window, and this is the clause that made it so.
  if (unreachable.length === 0) return `${head} Each one opens for members again from its very next scan.`;
  const rest = count - unreachable.length;
  const opened = rest === 0 ? "" : `${rest} open from the very next scan; `;
  const heard = unreachable.length === 1 ? "has" : "have";
  return `${head} ${opened}${unreachable.length} cannot be reached and ${heard} not heard it.`;
}

/**
 * One result row's confirmed half: the server did it AND this door has been heard from.
 *
 * <p>
 * The age is the one the SERVER saw when it did the work, never recomputed on the client — a
 * panel left open for ten minutes must not drift "confirmed 12s ago" into "confirmed 10m
 * ago". The panel is a receipt for an instant, and the instant is in its heading.
 * </p>
 */
export function doorConfirmedLine(heardFrom: string): string {
  return `confirmed — heard from ${heardFrom}`;
}

/**
 * One result row's unknown half, which is NOT a failure.
 *
 * <p>
 * The action succeeded at the server. What is unknown is the door's knowledge of it, which
 * is why this is a warning and not a danger — rendering it as danger would say the shut
 * failed, the opposite of true.
 * </p>
 *
 * <p>
 * <b>Four arms, and the reopen pair is written rather than reused.</b> An unconfirmed SHUT
 * may still be admitting booked members from its cache; an unconfirmed REOPEN has been
 * admitting them all along and merely does not yet know it is open again. One sentence for
 * both would describe one of the two states backwards.
 * </p>
 *
 * @param at the club-time clock face this door was last heard at, or null if it never has been.
 */
export function doorNotConfirmedLine(
  action: "shut" | "reopen", at: string | null, heardShut?: boolean,
): string {
  if (at === null) {
    return "NOT CONFIRMED — never heard from. It has never called in, so nothing is known about what"
      + " it is admitting.";
  }
  if (action === "reopen") {
    // R3-1: a door that HEARD the shut emptied its list, so "it has been admitting booked
    // members all along" is exactly backwards for it. Only a door the server says never
    // called since the shut gets the flat claim; anything else is hedged.
    const during = heardShut === true
      ? "It was told of the shut and has been opening for nobody"
      : heardShut === false
        ? "It has been admitting booked members from its cached list all along"
        : "It may have been admitting booked members from its cached list all along";
    return `NOT CONFIRMED — last heard ${at}. ${during}, and it will not know it is open again until`
      + " it reaches the server.";
  }
  return `NOT CONFIRMED — last heard ${at}. It may still admit booked members from its cached list`
    + " for up to six hours.";
}

/** What an admin recorded about this door's lock with no power. Never inferred from firmware. */
export const POWER_LOSS_LABELS: Record<string, string> = {
  not_established: "not established",
  released: "released",
  locked: "locked",
};

/**
 * The third line of every result row.
 *
 * <p>
 * It is on the result because a club-wide shut is the moment somebody asks what happens when
 * the power goes, and the answer is a property of the lock rather than of this software. An
 * unrecognised value reads as the honest default rather than as a blank: a row with nothing
 * where this sentence goes is read as "nothing happens".
 * </p>
 */
export function doorPowerLossLine(value: string): string {
  return `With no power this door is: ${POWER_LOSS_LABELS[value] ?? POWER_LOSS_LABELS.not_established}.`;
}

/** Said once at the foot of a result that carries any `not_established` door. */
export function doorPowerLossUnknownFooter(): string {
  return "Nobody has recorded what these doors do with no power. It is a property of the lock, not"
    + " of this software, and someone has to look.";
}

/**
 * The sentence that closes every shut result, and the one nobody thinks to ask for.
 *
 * <p>
 * An admin shutting every door in a club at once is, in that moment, wondering whether they
 * have trapped anybody. Nothing on this surface is on the exit path — the doors open from the
 * inside by hand — and the honest thing is to say so where the click is, not to leave the
 * question standing.
 * </p>
 */
export function doorExitIsMechanical(): string {
  return "Getting out is mechanical and none of this touches it: the doors open from the inside by"
    + " hand, with or without power. A door whose lock is released when the power is off is released"
    + " whatever this says.";
}

/**
 * What a door that is already shut says about itself, above its own control.
 *
 * Both halves of the time: `out_of_service_since` is an enrichment, and a payload that does
 * not carry it still has to say the door is shut. A dangling "It was shut on" with nothing
 * after it would read as a rendering fault.
 */
export function doorShutStandingNotice(
  name: string, since: string | null, shutBy: string | null = null,
): string {
  // B8. "It opens for nobody that can reach the club's server" parses as its own opposite —
  // the relative clause attaches to "nobody", so the sentence reads as "the only people it
  // opens for are the ones who can reach the server". Said the other way round there is
  // nothing to misparse: the subject is the server, and it is refusing.
  const head = `${name} is shut. The club's server is refusing every scan at this door.`;
  // A5: WHO and WHEN, not "you". The state paragraph told every admin in the club that they
  // personally had shut it.
  if (since === null) return shutBy === null ? head : `${head} Shut by ${shutBy}.`;
  return shutBy === null ? `${head} It was shut on ${since}.` : `${head} Shut by ${shutBy} on ${since}.`;
}

/**
 * The warning above a SHUT door's control when nothing can reach it (C2 / B3).
 *
 * <p>
 * It said, of every such door, that it "may still be admitting booked members from the list
 * it last downloaded". True of a named door. Flatly false of an unnamed one, which is sent an
 * empty list and opens for nobody the moment it loses the network — and every door in a club
 * is unnamed on install day.
 * </p>
 */
export function doorShutOfflineNotice(name: string, named: boolean, heardShut?: boolean): string {
  // R3-1. "Nothing can reach it, so it has not been told" was a conclusion drawn from an age
  // that froze the instant the door was shut, and it was printed in warning colours over a
  // board that had heard the refusal within one heartbeat. Where the server says the board
  // heard it, there is nothing to warn about at all and this notice does not render — the
  // caller checks; where the server says it did not, the sentence is stated flatly; where
  // the server cannot say, so does the sentence.
  const head = heardShut === false
    ? `${name} has not called in since it was shut, so it has not been told.`
    : `The club has not heard from ${name} since it was shut, so this page cannot say whether it`
      + " was told.";
  if (!named) {
    return `${head} It has no door name, so it holds no saved list: it opens for nobody until it is`
      + " back, shut or not.";
  }
  const admitting = heardShut === false ? "is still admitting" : "may still be admitting";
  return `${head} It ${admitting} booked members from the list it last downloaded, for up`
    + " to six hours after its last call.";
}

/**
 * A write that changed nothing, said as what it is (B10).
 *
 * <p>
 * A tab left open overnight armed "Shut this door" against a door somebody else had shut at
 * 21:48, and the screen reported success — so the admin learned that their click had done
 * something, and the club has no way to find out from this screen that it had not. WIRE-R2
 * §2 answers such a PATCH with `unchanged: true` and the CURRENT shut facts, which is the
 * only reason this sentence can name anybody.
 * </p>
 */
export function doorAlreadyNotice(
  name: string, shut: boolean, shutBy: string | null = null, at: string | null = null,
): string {
  const head = `Nothing changed — ${name} was already ${shut ? "shut" : "open"}.`;
  if (!shut) return head;
  if (shutBy === null && at === null) return head;
  if (shutBy === null) return `${head} It was shut on ${at}.`;
  return at === null ? `${head} It was shut by ${shutBy}.` : `${head} It was shut by ${shutBy} on ${at}.`;
}

/**
 * The club-wide banner, on every admin route while any door is shut (A1.5 / D5).
 *
 * <p>
 * W1.5 gave shut-all one audit row and a result screen, and gave the club nothing that says
 * at 05:50 the next morning that the doors are still shut. A volunteer club shuts every door
 * after an incident and finds out with thirty members outside. There is no timed auto-reopen,
 * so a standing banner is the only thing that gets the state back into an admin's head.
 * </p>
 *
 * <p>
 * The second sentence is true only when EVERY door is shut, so it appears only then: a club
 * with one of four doors shut can still let members in, and telling it otherwise is the
 * overstatement that teaches admins to ignore the banner.
 * </p>
 */
/** One shut door, as the banner and the fleet confirm both need to name it. */
export type ShutDoorFact = {
  id: string;
  name: string;
  online: boolean;
  shutByFleet: boolean;
  /**
   * R3-1: whether this shut door has been TOLD, which is not the same question as whether it
   * is reporting — and the banner counted "confirmed" from the second one. Optional so a
   * caller with an older view still compiles; `undefined` reads as "cannot tell".
   */
  heardShut?: boolean;
};

/**
 * The club-wide banner, stating BOTH halves of what "shut" means right now (C2).
 *
 * <p>
 * <b>The sentence this replaces was false.</b> It read "3 of 3 doors are shut. Members can't
 * get in." — flatly, whatever the doors were doing. A shut door that the club cannot reach
 * has not heard the refusal: it goes on admitting members with a booking from the list it
 * last downloaded, for up to six hours. So on the one screen a volunteer trusts in an
 * incident, the product asserted a lockdown it had not achieved, which is P1 and P6 broken
 * in the same eight words. Two reviewers reached it independently and it is the reason
 * <b>"can't get in" appears nowhere in this module any more</b> — there is a matrix test
 * that says so.
 * </p>
 *
 * <p>
 * <b>Confirmed and not-confirmed are counted separately and the not-confirmed ones are
 * NAMED</b>, because "1 not yet" sends nobody anywhere and "Side door" does. The
 * not-confirmed clause states what that door may still be doing rather than leaving the
 * reader to remember the six-hour rule.
 * </p>
 */
export function doorsShutBannerLine(shut: ShutDoorFact[], total: number): string {
  if (shut.length === 0 || total === 0) return "";
  // <b>R3-1: "confirmed" is `shut_heard_at`, not liveness.</b> This counted a door as
  // confirmed when it was reporting and as not-yet when it was quiet, and the shut itself is
  // what made a door go quiet on the old backend — so the banner on the one screen a
  // volunteer trusts during an incident counted the doors backwards. `heardShut` where the
  // view carries it, and the door falls through to the unsure arm where it does not.
  const unsure = shut.filter((d) => (d.heardShut === undefined ? !d.online : !d.heardShut));
  const head = `${shut.length} of ${total} ${total === 1 ? "door" : "doors"} shut`;
  if (unsure.length === 0) {
    return `${head} — every one of them confirmed. A shut door that has been told opens for`
      + " nobody. Getting out is mechanical and unchanged.";
  }
  const names = unsure.map((d) => d.name).join(", ");
  const confirmed = shut.length - unsure.length;
  const counted = confirmed === 0
    ? `none of them confirmed yet`
    : `${confirmed} confirmed, ${unsure.length} not yet`;
  // "has not been told" where the server says so; "the club cannot yet tell" where it is an
  // absent field and a frozen age. Both halves stated, neither invented.
  const told = unsure.every((d) => d.heardShut === false)
    ? `${unsure.length === 1 ? "has" : "have"} not been told`
    : `${unsure.length === 1 ? "has" : "have"} not confirmed they were told`;
  return `${head} — ${counted}: ${names} ${told}, so`
    + ` ${unsure.length === 1 ? "it" : "they"} may still admit booked members from the saved list for up`
    + " to six hours.";
}

/**
 * What the banner says when the doors were shut ONE AT A TIME (C1's third bullet).
 *
 * A fleet Reopen would not touch them — `reopen-all` reopens only what a shut-all shut — so
 * offering one here is offering a control that does nothing, which is exactly the "0 doors
 * reopened" dead end the ruling exists to close. The banner links to each door instead.
 */
export function doorsShutIndividuallyBanner(shut: ShutDoorFact[], total: number): string {
  const names = shut.map((d) => d.name).join(", ");
  const head = `${shut.length} of ${total} ${total === 1 ? "door" : "doors"} shut`;
  return `${head}, ${shut.length === 1 ? "one at a time" : "each on its own"}: ${names}.`
    + ` Reopen ${shut.length === 1 ? "it" : "each of them"} from ${shut.length === 1 ? "its" : "their"} own page —`
    + " reopening the doors shut together would not touch these.";
}

/**
 * The fleet Reopen control's label, counting what it will ACTUALLY reopen (C1).
 *
 * It used to read "Reopen all 3" from `doors.length` — the club's total — while the request
 * reopens only the doors a shut-all shut. An admin who had shut one door on its own and then
 * pressed it got `{"doors": []}` and the words "0 doors reopened", with nothing saying why.
 */
export function doorFleetReopenLabel(count: number): string {
  return count === 1 ? "Reopen the door shut together" : `Reopen the ${count} doors shut together`;
}

/** Named, not counted: the doors a fleet reopen will leave shut, said before it is pressed. */
export function doorsStayShutNotice(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) {
    return `${names[0]} stays shut — it was shut on its own. Reopen it from its page.`;
  }
  return `${names.join(", ")} stay shut — each was shut on its own. Reopen them from their own pages.`;
}

/**
 * A fleet result that changed nothing, said with its reason (C1).
 *
 * "0 doors reopened" with no explanation is the exact dead end the ruling names. A
 * zero-change result never prints without the sentence that says why it was zero.
 */
export function doorFleetNoChangeNotice(action: "shut" | "reopen"): string {
  if (action === "reopen") {
    return "No doors were reopened, because none of them were shut together. A door shut on its own"
      + " stays shut until it is reopened from its own page.";
  }
  return "No doors were shut, because every door was already shut.";
}

/**
 * The confirm label for deleting a door.
 *
 * <p>
 * Deleting is not a revocation and locks nothing out — the board still holds the club's one
 * API key, so it registers itself again on its next heartbeat. The difference from a box is
 * what comes back: a gate re-registers with `GateKey = null`, so the door's name is what is
 * actually lost, and the label says so. It is also the only way to change a row's kind,
 * which is why the control matters more here than the wording suggests.
 * </p>
 */
export function gateDeleteConfirm(): string {
  // A2 / B5. The old confirm was 55 words and said only that the NAME, the location and the
  // power answer go — so an admin deleting a door had every reason to think they were
  // deleting its history too. They are not: the scans stay in the club log until the club's
  // own retention rule takes them (WIRE-R2 §1). The ruling is that the confirm says so and
  // that everything else moves to the page text beside it.
  return "Delete this door? Its name, its place and its power answer go. Its past scans stay in the"
    + " club log under its old name.";
}

/**
 * Delete's consequence at REST, beside the control, as a statement (A8 / A12 / C10).
 *
 * <p>
 * The confirm above is a question, and a question printed permanently beside a button reads
 * as a control mid-ask. This says the same three facts flatly. It also says them in a
 * volunteer's words: the old sentence was "The door re-registers on its next heartbeat with
 * no name", which is three of our nouns in a row and does not mention that the location note
 * and the power-cut answer are destroyed — the two facts on the card an admin most recently
 * took the trouble to write down.
 * </p>
 */
export function gateDeleteStandingNotice(name: string, retentionDays: number | null = null): string {
  // A2: the sentence a reviewer went looking for and did not find. Deleting a door does NOT
  // delete its scans — the rows stay under the name they stored until the club's own rule
  // takes them — and an admin who believes otherwise either deletes to destroy records that
  // survive anyway, or refuses to delete a board that is in a skip.
  const kept = retentionDays === null
    ? "the club's retention rule"
    : `the club's ${retentionDays}-day rule`;
  return `Deleting ${name} throws away everything written down about it — its name, where the board`
    + " is, and what the lock does with no power. Its past scans are NOT deleted: they stay in the"
    + ` club log under its old name until ${kept} takes them, and the log lists it under “Removed`
    + " doors”. It does not lock the board out either: it still has the club's key, so it reappears"
    + " here as a new door with nothing filled in the next time it calls in. Unplug it if you meant"
    + " to retire it.";
}

/** What each access policy is called on the settings screen. */
export const GATE_POLICY_LABELS: Record<GateAccessPolicy, string> = {
  active_member: "Any member in good standing",
  booking_window: "Only a member with a booking",
};

/**
 * What a policy does, in the words the hint beside the picker needs.
 *
 * <p>
 * <b>The staff exemption is named on ONE arm, and the word "operator" is gone from both.</b>
 * There is no operator role in this product — the rule is `User.IsAdmin`, not "has no
 * membership row", which was a fixture-shaped reading of a test that deleted the row to get
 * there. And the exemption belongs only under `booking_window`, where it exempts somebody
 * from something: under `active_member` every active member already passes, so printing an
 * exemption there would describe a privilege that changes no outcome — while being FALSE of
 * the one admin it could matter to, since a club admin whose own membership is suspended is
 * barred exactly like anybody else.
 * </p>
 *
 * <p>
 * <b>Both arms say what a booking's own QR can do</b>, because that is the half nobody would
 * guess from a policy name: a booking code is not a standing building key, and it opens a
 * door only inside its own booking's window whichever policy is set.
 * </p>
 *
 * <p>
 * The early-entry number is interpolated rather than described, because it is the setting
 * directly below and an admin reading "within the early-entry window" has to scroll and do
 * arithmetic to learn what they have actually chosen. The `active_member` arm deliberately
 * does NOT interpolate a number: that horizon is the widest of the early-entry minutes and
 * the roster and cue windows together, so any single figure printed there would be wrong for
 * some club. The ONE number that is the same for every club — the four-hour cap the API
 * applies (`GateAccess.MaxEarlyEntryMinutes`) — is spelt in words for that reason, so it
 * cannot be read as the club's own setting.
 * </p>
 *
 * <p>
 * <b>Neither arm bounds a booking at "and has not yet ended" any more.</b> The no-show sweep
 * marks a booking `NoShow` when nobody checks in, and under the old rule that status took the
 * door away — so a member arriving ten minutes late for a court they had paid for found the
 * front door shut by a penalty sweep. It does not now, and the copy names the condition that
 * really bounds it (the booking's own code still being live) rather than a clock time: "until
 * the booking ends" promises less than the code buys, and stating an end-plus-grace
 * arithmetic here would promise more than this screen can know.
 * </p>
 *
 * <p>
 * <b>The admin carve-out carries its third limit inside the same sentence.</b> "Club admins
 * always pass this booking check" is true of a door that can reach the API and false of one
 * that cannot: a cut-off door decides from its cached roster, that roster is built from
 * bookings, and there is no admin flag anywhere in it. Split into a following sentence it is
 * a footnote; inside the claim it is part of the claim.
 * </p>
 */
export function describeGatePolicy(policy: GateAccessPolicy, earlyEntryMinutes: number): string {
  if (policy === "booking_window") {
    return `Only a member whose booking has already started, or starts within the next`
      + ` ${earlyEntryMinutes} ${earlyEntryMinutes === 1 ? "minute" : "minutes"}, and whose code`
      + ` for that booking is still live — on any court. Anyone else is turned away. Arriving late`
      + ` is not a lockout: the no-show sweep does not take that code away. Club admins always pass`
      + ` this booking check, but only at a door that can still reach the club — an offline door`
      + ` holds bookings, not admins; a suspended, pending or rejected membership still turns`
      + ` anyone away, admin or not.`;
  }
  return "Any member whose own code scans opens the door at any hour, unless their membership is"
    + " suspended, pending approval or rejected. A booking's QR is narrower: it opens a door only"
    + " from about the time the member's phone starts showing that code — never more than four"
    + " hours before the booking — and only while that code is still live. Arriving late is not a"
    + " lockout: the no-show sweep does not take that code away. A cancelled booking's code opens"
    + " nothing.";
}

/**
 * What the "Early entry" field governs, which is not the same thing under the two policies.
 *
 * <p>
 * <b>This is the sentence the screen was wrong about.</b> The hint read "How long before a
 * booking starts its holder may come in", flatly, and the field's value was printed into the
 * policy hint above it as if it were the door's whole window. Under `booking_window` it is.
 * Under `active_member` — the API's default, so the state a club actually ships in — the
 * door's horizon is the WIDER of this number and the horizon the member's phone uses, so at
 * the shipped defaults the screen said 30 and the door opened at 130. An admin lowering it to
 * narrow the door narrowed nothing and was told nothing.
 * </p>
 *
 * <p>
 * Under the open policy the number is still doing two real jobs, and naming both is what
 * makes an edit predictable: it is how far the door's OFFLINE roster reaches, and it is the
 * FLOOR under the online horizon (a door must not be stricter online than it is during an
 * outage). What it is not, there, is the ceiling — so the hint points at the two fields that
 * decide the rest, by the labels they actually carry on screen.
 * </p>
 */
export function describeEarlyEntry(policy: GateAccessPolicy): string {
  if (policy === "booking_window") {
    return "Under the policy above this is the door: a booking's QR opens a door from this many"
      + " minutes before the booking starts, and a door's cached roster reaches exactly that far.";
  }
  return "Under the policy above this is the offline list and the floor, not the whole answer: a"
    + " door's cached roster reaches this far ahead, and a booking's QR never opens a door less"
    + " early than this. Online a door also opens as early as the member's phone shows the code —"
    + " “Offline roster reach” plus “Lights on this early” under Court boxes above, and never more"
    + " than 240 minutes.";
}

/**
 * The sentence the two COURT-side settings gained, because under the default policy they
 * decide a door.
 *
 * <p>
 * "Lights on this early" and "Offline roster reach" sit under a heading that says Court boxes,
 * are named for courts, and are two thirds of what decides when a booking QR opens a DOOR
 * under `active_member`. An admin raising the roster reach to give the boxes a longer outage
 * cushion widened every door in the club by the same amount, and neither field said a word.
 * </p>
 *
 * <p>
 * It says the opposite under the strict policy rather than going silent. An admin who has read
 * the sentence once needs to know it has stopped applying — and which field took over — rather
 * than to find it simply missing and wonder whether the screen or their memory is wrong.
 * </p>
 */
export function describeCourtSettingDoorReach(policy: GateAccessPolicy): string {
  if (policy === "booking_window") {
    return "Under the club's current door policy this does not reach the doors — “Early entry”"
      + " under Door gates does that.";
  }
  return "Under the club's current door policy this also decides how early a booking's QR opens a"
    + " door: “Offline roster reach” plus “Lights on this early”, capped at 240 minutes.";
}

/**
 * The effective horizon, computed from the form and printed as a number.
 *
 * <p>
 * Three fields on two blocks decide it, two of them filed under Court boxes, and under the
 * default policy the answer is none of the three. An admin cannot be asked to do that
 * arithmetic from hints; a hint that asked them to would be this screen describing a door
 * wrongly for the fourth time. The figure comes from
 * {@link import("./tenantSettings").doorBookingHorizonMinutes}, which mirrors
 * `BookingCodeWindow.DoorHorizonMinutes` including its cap, so the sentence moves when the
 * form moves and cannot drift from what the door will do.
 * </p>
 */
export function describeDoorBookingHorizon(minutes: number): string {
  return `With these settings a booking QR opens a door from ${minutes}`
    + ` ${minutes === 1 ? "minute" : "minutes"} before the booking.`;
}

/**
 * The degraded mode, said once at the top of the settings block.
 *
 * <p>
 * It belongs on the screen because it is the one door behaviour nobody would predict from
 * the policy picker: the offline fallback is the cached roster, the roster is built from
 * BOOKINGS, and so a club running the open `active_member` policy silently becomes
 * booking-only the moment a door loses the network. An admin who does not know that reads
 * a member locked out during an outage as a broken lock.
 * </p>
 *
 * <p>
 * The unnamed-door clause is here rather than only on the Devices page because this block is
 * where a club decides what its doors do: a heartbeat for a gate with no name answers an
 * empty roster, so "falls back to the roster it last downloaded" is flatly untrue of a door
 * nobody has named, and that is the state every door in the club is in on install day.
 * </p>
 *
 * <p>
 * <b>And the cap, which is where "only members with a booking can get in" stops being the
 * whole rule.</b> The roster is ordered by `StartsAt` then `Id` and cut to
 * {@link GATE_ROSTER_MAX_ENTRIES} AFTER ordering, so the bookings that fall off are the
 * LATEST-STARTING ones — the members who arrive last on the busiest night of the week. A
 * club running sixty bookings through a league evening has twelve members holding a live
 * booking and no way through a door that has lost the network, and the previous wording
 * described that state as one in which they got in. Said as start order rather than as "the
 * first 48", because "first" reads as first-booked and would send an admin to tell the
 * wrong member to re-book.
 * </p>
 */
export function gateOfflineFallbackNotice(): string {
  return "When a door cannot reach the club it falls back to the list of bookings it last"
    + " downloaded, and that list holds bookings and nothing else. So while a door is offline, only members"
    + " with an upcoming or running booking can get in — whichever policy is set below. That list"
    + ` holds at most ${GATE_ROSTER_MAX_ENTRIES} bookings, taken in start order, so on a busy night`
    + " the latest-starting bookings beyond that cannot get in while the door is offline. A door"
    + " nobody has named yet is sent no list at all, so it opens nothing while it is offline.";
}
