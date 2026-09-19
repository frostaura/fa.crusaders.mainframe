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
 */
export function gateOutOfServiceNotice(): string {
  return "The club is not alerted about its silence, and the API refuses every scan at this door"
    + " from the instant the switch is thrown. A door that can still reach the API hears that"
    + " refusal and opens for nobody, with no fall back to its roster. A door that has also lost"
    + " the network never hears it, and keeps admitting members with a booking from the roster it"
    + " last downloaded until that goes stale, which takes up to six hours. Bookings, check-ins,"
    + " refunds and no-show penalties are untouched either way: opening a door is not attendance.";
}

/**
 * The confirm label for taking a door out of service.
 *
 * <p>
 * Shorter than the notice — a confirm has room for one clause per consequence — but it must
 * not out-promise it, and it must not UNDER-promise it either: the pair on the box side
 * disagreed twice, at different call sites, about what the very next click would do. All
 * three halves that vary are here, compressed: the reachable door that stops opening, the
 * cut-off door that does not, and the fact that nothing settles.
 * </p>
 */
export function gateOutOfServiceConfirm(): string {
  return "Out of service? A door that can reach the API opens for nobody from this click. One that"
    + " has also lost the network keeps admitting booked members from its cached roster for up to"
    + " six hours. No booking, check-in or no-show penalty changes.";
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
 * some club.
 * </p>
 */
export function describeGatePolicy(policy: GateAccessPolicy, earlyEntryMinutes: number): string {
  if (policy === "booking_window") {
    return `Only a member whose booking has already started, or starts within the next`
      + ` ${earlyEntryMinutes} ${earlyEntryMinutes === 1 ? "minute" : "minutes"}, and has not yet`
      + ` ended — on any court. Anyone else is turned away. Club admins always pass this booking`
      + ` check; a suspended, pending or rejected membership still turns anyone away, admin or not.`;
  }
  return "Any member whose own code scans opens the door at any hour, unless their membership is"
    + " suspended, pending approval or rejected. A booking's QR is narrower: it opens a door only"
    + " from about the time the member's phone starts showing that code until the booking ends,"
    + " and not at all once the booking is cancelled.";
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
 */
export function gateOfflineFallbackNotice(): string {
  return "When a door cannot reach the API it falls back to the roster it last downloaded, and"
    + " that roster holds bookings and nothing else. So while a door is offline, only members"
    + " with an upcoming or running booking can get in — whichever policy is set below. A door"
    + " nobody has named yet is sent no roster at all, so it opens nothing while it is offline.";
}
