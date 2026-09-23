import type { AdminSettings } from "@/lib/api";
import { DOOR_BOOKING_HORIZON_MAX_MINUTES, doorBookingHorizonBasis } from "@/lib/tenantSettings";
import { GATE_POLICY_LABELS } from "@/lib/gateCopy";
import { SETTING_LABELS } from "@/lib/settingsSchema";

/**
 * The sentences the Settings page DERIVES — answers, rather than fields.
 *
 * <p>
 * Each exists because the fields alone let an admin draw the wrong conclusion: two per-day caps
 * that compose, and a door horizon decided by three fields on two sections.
 * </p>
 */

/**
 * The two per-day caps, in one sentence, because neither field alone says how they compose.
 *
 * <p>
 * Ruling 3: Dean asked for SLOTS, the number already on disk is MINUTES, and both stay — the most
 * restrictive of the two is what a member meets. A club that sets "4 slots" and leaves the minutes
 * at 60 has set an hour and would never learn it from either field. Where the slots key has not
 * shipped, the sentence says what is true — the minutes cap alone — rather than quoting a default
 * this console invented.
 * </p>
 */
export function capsSentence(settings: AdminSettings): string {
  const slots = settings.member_max_slots_per_day;
  const minutes = settings.member_per_day_max_minutes;
  const slice = settings.slice_minutes;
  const minutesClause = Number.isFinite(minutes) && minutes > 0 ? `${minutes} minutes a day` : null;
  if (slots === undefined) {
    return minutesClause
      ? `Today a member may hold ${minutesClause}. Admins are not limited.`
      : "Members are not limited by time today, and admins never are.";
  }
  const slotsClause = slots > 0 ? `${slots} slot${slots === 1 ? "" : "s"} a day` : null;
  if (!slotsClause && !minutesClause) return "No per-day limit at all — a member may hold as much as the club is open for.";
  if (!slotsClause) return `Only the time limit applies: ${minutesClause}. Admins are not limited.`;
  if (!minutesClause) return `Only the slot limit applies: ${slotsClause}. Admins are not limited.`;
  const asMinutes = Number.isFinite(slice) && slice > 0 ? slots * slice : null;
  const which = asMinutes === null
    ? "Whichever is stricter is what a member meets."
    : asMinutes <= minutes
      ? `${slotsClause} is ${asMinutes} minutes, so the slot limit is the one a member meets.`
      : `${minutesClause} is stricter than ${slotsClause}, so the time limit is the one a member meets.`;
  return `A member may hold ${slotsClause} and ${minutesClause}. ${which} A group may lower either and may never raise one. Admins are not limited.`;
}

/**
 * Which fields the door horizon was read from. (C13)
 *
 * <p>
 * A derived sentence that ignores the control directly beside it, and says nothing about why,
 * reads as a broken page and sends an admin to change the wrong number. Under `active_member` the
 * number really is read from two fields on the Court boxes section; this says so, by the captions
 * the fields wear. Under the open policy a booking QR is not the only way in at all, and a block
 * quoting one horizon and never mentioning that reads as the whole rule.
 * </p>
 */
export function doorHorizonBasis(settings: AdminSettings): string {
  const basis = doorBookingHorizonBasis(settings);
  const named = basis.from.map((key) => `“${SETTING_LABELS[key]}”`).join(" plus ");
  const early = `“${SETTING_LABELS.gate_early_entry_minutes}”`;
  const parts: string[] = [];

  if (settings.gate_access_policy === "booking_window") {
    parts.push(
      `Under “${GATE_POLICY_LABELS.booking_window}” that is ${named} on this block and nothing`
      + " else — change it and this sentence changes with it.",
    );
  } else if (basis.floorGoverns) {
    parts.push(
      `Under “${GATE_POLICY_LABELS.active_member}” it comes from ${named} on this block: the two`
      + ` court-box windows would give ${basis.courtWindowsMinutes}, and a door never opens`
      + " less early than this floor.",
    );
  } else {
    parts.push(
      `Under “${GATE_POLICY_LABELS.active_member}” it comes from ${named} — both on the “Court`
      + ` boxes & identification” block above, not from ${early}, which only sets a floor`
      + ` (currently ${basis.floorMinutes}). Editing ${early} below that changes nothing here.`,
    );
  }

  if (basis.capped) {
    parts.push(`Those two add up to more than ${DOOR_BOOKING_HORIZON_MAX_MINUTES} minutes, which is the cap, so the answer stops there.`);
  }

  if (settings.gate_access_policy === "active_member") {
    parts.push(
      "A booking QR is not the only way in under this policy, either: a member's own code opens a"
      + " door whenever their membership is active, booking or no booking.",
    );
  }

  return parts.join(" ");
}
