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
 * names it the audit rows for every scan at it carry a null `gate_key`.
 * </p>
 */
export const NEW_GATE_BADGE = "New — name this door";

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
 *   <li><b>The door may still open anyway, for a while.</b> This is the half worth being
 *       honest about. A 403 is not a refusal to the firmware — it is an outage, and the
 *       gate's documented response to any non-200 is to fall back to the roster it last
 *       downloaded. Its heartbeat is being refused too, so that roster stops being
 *       refreshed and eventually goes stale, and a stale roster admits nobody. Until then a
 *       member whose booking is in the cache can still get in. Saying "the door stops
 *       opening" flatly would be the same class of falsehood as the box side's "nobody can
 *       check in there", which survived three rounds.</li>
 *   <li><b>No money moves.</b> A gate decision never writes a booking, a `CheckedInAt`, a
 *       ledger entry or a settlement row, online or from the roster. That is worth stating
 *       rather than leaving out, because the identical control one row above — on a court
 *       box — waives no-show penalties on a whole court, and an admin who has read that
 *       notice has every reason to assume this one does something similar.</li>
 * </ol>
 */
export function gateOutOfServiceNotice(): string {
  return "The club is not alerted about its silence, and the API stops answering scans at this"
    + " door, so it opens nothing from the instant the switch is thrown. The door keeps whatever"
    + " roster it last downloaded, so a member with a booking already in that cache may still get"
    + " in until it goes stale — nobody else will. Bookings, check-ins, refunds and no-show"
    + " penalties are untouched either way: opening a door is not attendance.";
}

/**
 * The confirm label for taking a door out of service.
 *
 * <p>
 * Shorter than the notice — a confirm has room for one clause per consequence — but it must
 * not out-promise it: the pair on the box side disagreed twice, at different call sites,
 * about what the very next click would do. Both halves that vary are here, compressed: the
 * cached-roster caveat, and the fact that nothing settles.
 * </p>
 */
export function gateOutOfServiceConfirm(): string {
  return "Out of service? The API stops answering scans at this door. It may still open from its"
    + " cached roster until that goes stale. No booking, check-in or no-show penalty changes.";
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
 * Both arms name the accounts that pass either way, because that exemption is the one an
 * admin cannot guess and the one that matters at 6am: a user with no membership row is not
 * barred — that is how an operator or a club admin opens a door at all.
 * </p>
 *
 * <p>
 * The early-entry number is interpolated rather than described, because it is the setting
 * directly below and an admin reading "within the early-entry window" has to scroll and do
 * arithmetic to learn what they have actually chosen.
 * </p>
 */
export function describeGatePolicy(policy: GateAccessPolicy, earlyEntryMinutes: number): string {
  if (policy === "booking_window") {
    return `Only a member whose booking has already started, or starts within the next`
      + ` ${earlyEntryMinutes} ${earlyEntryMinutes === 1 ? "minute" : "minutes"}, and has not yet`
      + ` ended — on any court. Anyone else is turned away. Accounts with no membership of their`
      + ` own, such as club admins and operators, always pass.`;
  }
  return "Any member whose code scans opens the door, unless their membership is suspended,"
    + " pending approval or rejected. Accounts with no membership of their own, such as club"
    + " admins and operators, always pass.";
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
 */
export function gateOfflineFallbackNotice(): string {
  return "When a door cannot reach the API it falls back to the roster it last downloaded, and"
    + " that roster holds bookings and nothing else. So while a door is offline, only members"
    + " with an upcoming or running booking can get in — whichever policy is set below.";
}
