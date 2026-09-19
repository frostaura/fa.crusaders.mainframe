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
    + " sent an empty roster, so it opens nothing at all while it is offline.";
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
  return "The club is not alerted about its silence, and the API refuses every scan at this door"
    + " from the instant the switch is thrown. A door that can still reach the API hears that"
    + " refusal and opens for nobody, with no fall back to its roster. A door that has also lost"
    + " the network never hears it, and keeps admitting members with a booking from the roster it"
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

/**
 * The confirm label for shutting a door.
 *
 * <p>
 * Shorter than the notice — a confirm has room for one clause per consequence — but it must
 * not out-promise it, and it must not UNDER-promise it either: the pair on the box side
 * disagreed twice, at different call sites, about what the very next click would do. All
 * three halves that vary are here, compressed: the reachable door that stops opening, the
 * cut-off door that does not, and the fact that nothing settles.
 * </p>
 *
 * <p>
 * It opens with the words on the button rather than with "Out of service?", which is what it
 * used to say — a confirm whose first word is not the word on the control it is attached to
 * reads as a different control.
 * </p>
 */
export function doorShutConfirm(): string {
  return `${DOOR_SHUT_LABEL}? A door that can reach the API opens for nobody from this click. One`
    + " that has also lost the network keeps admitting booked members from the list it last"
    + " downloaded for up to six hours. No booking and no no-show penalty changes, and a door marks"
    + " nobody as having arrived.";
}

/**
 * The confirm label for reopening a door, whose honest half is the OPPOSITE of shutting's.
 *
 * <p>
 * A scan is a pull, so a reachable door opens for members again on the very next scan — there
 * is nothing to queue, nothing to deliver, and no heartbeat to wait for. Saying "it picks
 * this up on its next heartbeat" here, as the door editors correctly say of a NAME, would
 * invent a delay the mechanism does not have.
 * </p>
 *
 * <p>
 * And the cut-off door inverts: it never stopped admitting booked members from its cached
 * list, so nothing changes there and the reopen is not news to it.
 * </p>
 */
export function doorReopenConfirm(): string {
  return `${DOOR_REOPEN_LABEL}? A door that can reach the API opens for members again from the very`
    + " next scan — there is no wait. A door that has lost the network has been admitting booked"
    + " members from its cached list all along, and nothing changes there.";
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
export function doorFleetShutConfirm(count: number): string {
  return `Shut ${allDoors(count)}? Every door that can reach the club's server opens for nobody from`
    + " this click. Any door that has lost the network keeps admitting booked members from the list"
    + " it last downloaded for up to six hours. No booking and no no-show penalty changes.";
}

/** Reopening every door the club shut together. Same inversion as {@link doorReopenConfirm}. */
export function doorFleetReopenConfirm(count: number): string {
  return `Reopen ${allDoors(count)}? Every door that can reach the club's server opens for members`
    + " again from the very next scan. A door that has lost the network has been admitting booked"
    + " members from its cached list all along.";
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
export function doorNotConfirmedLine(action: "shut" | "reopen", at: string | null): string {
  if (at === null) {
    return "NOT CONFIRMED — never heard from. It has never called in, so nothing is known about what"
      + " it is admitting.";
  }
  if (action === "reopen") {
    return `NOT CONFIRMED — last heard ${at}. It has been admitting booked members from its cached`
      + " list all along, and it will not know it is open again until it reaches the server.";
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
export function doorShutStandingNotice(name: string, since: string | null): string {
  const head = `${name} is shut. It opens for nobody that can reach the club's server.`;
  return since === null ? head : `${head} It was shut on ${since}.`;
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
export function doorsShutBanner(shut: number, total: number): string {
  const head = `${shut} of ${total} ${total === 1 ? "door" : "doors"} ${shut === 1 ? "is" : "are"} shut.`;
  return shut >= total ? `${head} Members can't get in.` : head;
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
  return "Delete? The door re-registers on its next heartbeat with no name.";
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
      + ` this booking check, but only at a door that can still reach the API — an offline door`
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
  return "When a door cannot reach the API it falls back to the roster it last downloaded, and"
    + " that roster holds bookings and nothing else. So while a door is offline, only members"
    + " with an upcoming or running booking can get in — whichever policy is set below. That list"
    + ` holds at most ${GATE_ROSTER_MAX_ENTRIES} bookings, taken in start order, so on a busy night`
    + " the latest-starting bookings beyond that cannot get in while the door is offline. A door"
    + " nobody has named yet is sent no roster at all, so it opens nothing while it is offline.";
}
