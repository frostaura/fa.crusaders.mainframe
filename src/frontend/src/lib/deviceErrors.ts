import { ApiError } from "./api";
import { RELAYS } from "../components/ButtonMapEditor";
import { DEVICE_NAME_MAX_LENGTH, GATE_KEY_MAX_LENGTH } from "./gateCopy";
import { LOCATION_NOTE_MAX_LENGTH } from "../components/doors/DoorCardFields";
import {
  DEVICE_ALERT_COOLDOWN_MAX_MINUTES, DEVICE_ALERT_COOLDOWN_MIN_MINUTES,
  GATE_EARLY_ENTRY_MAX_MINUTES, GATE_EARLY_ENTRY_MIN_MINUTES,
  GATE_UNLOCK_MAX_SECONDS, GATE_UNLOCK_MIN_SECONDS,
} from "./tenantSettings";

/**
 * Device refusals, turned into sentences an admin can act on.
 *
 * <p>
 * Shared by the Devices page, the device API key panel and — for the door-gate numbers —
 * the Settings page, rather than living on one of them, because they talk to the same
 * endpoints and a refusal decoded in only one place is a toast reading
 * `court_number_not_found` in the other. The Settings page used to decode its own
 * refusals by swapping underscores for spaces, which is why a bad gate value would have
 * read `gate unlock seconds out of range` and said nothing about the bound.
 * </p>
 *
 * <p>
 * The server answers with a stable `error` token, and for the button-map mismatch it
 * also names the box, the relay index the map reaches for and how many courts the box
 * has — because the fix is on one of two screens and the message has to say which.
 * Anything unrecognised falls back to the server's own `message`, then the token.
 * </p>
 */
const DEVICE_ERROR_TEXT: Record<string, string> = {
  court_numbers_required_for_court_box: "A court box needs at least one court. Pick the court on relay A.",
  too_many_courts_for_relay_bank: `A box drives at most ${RELAYS.length} courts — one per relay, A to D.`,
  duplicate_court_numbers: "Each court can be on only one relay. Two relays point at the same court.",
  // The API checks every court number against the courts table on update
  // (DeviceRegistryService.CourtNumberNotFound). The pickers only offer real courts, so
  // this mostly means a court was deleted while the form was open.
  court_number_not_found: "One of those court numbers is not a court at this club. Refresh the page and pick the court again — if it is missing, add it under Courts.",
  // ButtonMap.TryParse refused the map itself — an unknown token, or a grant past the
  // relay's hard cap. The editor bounds the field, so this is a map that arrived from
  // somewhere else, or a hand-edited one.
  button_map_invalid: "One of the buttons is set to something a box cannot do. Court is A–D and a grant is 1–90 minutes.",

  // --- door gates -------------------------------------------------------------------
  //
  // A row's kind is set by the board's first heartbeat and is not editable, so both of
  // these mean the screen offered an editor for the wrong kind of board — which is a
  // frontend defect, not something an admin mistyped. The copy says what to do anyway,
  // because the one way it reaches an admin for a legitimate reason is a row that was
  // deleted and re-registered as the other kind while the form was open.
  gate_key_not_a_gate: `A door name only belongs on a door gate, and this row is a court box. Refresh the page — if the board really is a door, delete the row and let it register itself again.`,
  court_fields_on_a_gate: "Courts and button maps belong on a court box, and this row is a door gate. A door drives no courts. Refresh the page and edit the door's name instead.",
  // The editor's own maxLength stops this at the keyboard, so it reaches an admin through a
  // pasted value or a row edited from somewhere else. It had no entry at all and fell through
  // to the underscore swap — "gate key too long", which names no bound and no field.
  gate_key_too_long: `A door name is at most ${GATE_KEY_MAX_LENGTH} characters. Shorten it and save again.`,
  /**
   * The third of the kind refusals, and it had no entry at all.
   *
   * The API has answered this since the door-card migration landed and nothing rendered a
   * sentence for it — an admin met the raw token. It became reachable in practice when the
   * door page's two editors became one (A19): a single save now carries the door-card
   * fields as well as the name, so a row that turned out to be a court box is refused on
   * THESE rather than on `gate_key`, and this is the sentence they get.
   */
  door_fields_on_a_court_box: "Where the board is, and what its lock does with no power, are things"
    + " only a door has — and this row is a court box. Refresh the page; if the board really is a"
    + " door, delete the row and let it register itself again.",
  location_note_too_long: `Where the board is has to be at most ${LOCATION_NOTE_MAX_LENGTH} characters. Shorten it and save again.`,
  /**
   * A2 / B2 / R3-15 — the one that used to be a 500 with the EF exception in it.
   *
   * A name over the column's 128 threw `DbUpdateException` out of the save and the client
   * got a developer page. The API validates now (WIRE-R3 §3); the field's own `maxLength`
   * stops it at the keyboard, so this reaches an admin through a paste or a row edited
   * elsewhere — and it names the FIELD, because the form has two name-shaped boxes and the
   * old sentence named neither.
   */
  name_too_long: `“What the club calls it” is at most ${DEVICE_NAME_MAX_LENGTH} characters. Shorten it and save again.`,

  // --- the club door log's own refusals, added this round ------------------------------
  //
  // A-C2 / R3-13: `?door=` naming a board that is no longer on the club's list answered 200
  // with an empty page, so the screen said "no scans at any door" — a claim about the CLUB
  // built out of a filter pointing at nothing. The API refuses it now (WIRE-R3 §4) and the
  // page has a sentence for it; it must never read as "nothing happened".
  door_not_found: "That door is no longer on the club's list, so these filters match nothing."
    + " Its past scans are still kept — pick it under “Removed doors”, or choose All doors.",
  day_invalid: "That is not a day this log can be read for. Pick one from the calendar.",
  limit_invalid: "That page size could not be read. Press Refresh to start the list again.",
  reason_invalid: "That is not a reason a door records. Set Outcome back to All outcomes.",
  period_invalid: "That is not a range this log offers. Pick one from the When list.",
  range_conflict: "That link asks for two different ranges at once. Pick one from the When list.",
  /**
   * R3-34 / B13 — the write this tab sent was written against a state that had moved.
   *
   * It is not a failure of the click and the sentence must not read as one: nothing was
   * changed, the door is in whatever state somebody else left it, and the answer is to look
   * before deciding again.
   */
  door_changed: "Nothing was changed — this door was shut or reopened by somebody else since this"
    + " page last read it. The screen is refreshing; check what it says now before deciding again.",
  power_loss_behaviour_unknown: "What this door does with no power has to be one of the three"
    + " answers on the form. Pick one and save again.",

  // --- the club door log's own refusals ------------------------------------------------
  //
  // E3: a mistyped range used to answer 200 with the FULL unfiltered result, so an admin who
  // fat-fingered a date exported everything believing it narrowed. The API refuses now, and
  // these are the sentences those refusals reach a person as — without them the page shows
  // its generic "could not be read", which says nothing about which field to look at.
  from_invalid: "That start date could not be read, so the scans below were not narrowed to it."
    + " Pick a range from the When list.",
  to_invalid: "That end date could not be read, so the scans below were not narrowed to it."
    + " Pick a range from the When list.",
  cursor_invalid: "This page of older scans could not be read. Press Refresh to start the list again.",
  outcome_invalid: "That is not an outcome a door records. Set Outcome back to All outcomes.",

  // --- the club's public contact (B10 / C12) -------------------------------------------
  //
  // The console validates both before it sends, so these reach an admin only through a
  // hand-edited settings document or a value saved from somewhere else — and the value is
  // printed on the card that goes on a wall, which is why the server checks at all.
  club_contact_phone_invalid: "A club phone number can hold digits, spaces and + - ( ) , and needs"
    + " at least five digits. Check it and save again.",
  club_contact_email_invalid: "That is not an email address the club can be reached at. Check it"
    + " and save again.",

  // The three tenant numbers, each named with the bound the API holds, because
  // "out of range" alone leaves an admin guessing which end they went past.
  gate_unlock_seconds_out_of_range: `Unlock time has to be between ${GATE_UNLOCK_MIN_SECONDS} and ${GATE_UNLOCK_MAX_SECONDS} seconds. A door never holds the lock open longer than ${GATE_UNLOCK_MAX_SECONDS} seconds whatever is set here.`,
  gate_early_entry_minutes_out_of_range: `Early entry has to be between ${GATE_EARLY_ENTRY_MIN_MINUTES} and ${GATE_EARLY_ENTRY_MAX_MINUTES} minutes.`,
  // Confirmed against the API rather than guessed: this comment used to say the token was
  // inferred from `button_map_invalid`'s shape because the contract never spelt it out.
  gate_access_policy_invalid: "Who may open a door has to be either “Any member in good standing” or “Only a member with a booking”. Pick one and save again.",

  // Not a door setting even though it arrived with the door work: the cooldown bounds the
  // "not reporting" mail for every board, court boxes included. The sentence says what the
  // number buys as well as the bound, because "5 to 1440" alone gives an admin no way to
  // choose between 30 and 300.
  device_alert_cooldown_minutes_out_of_range: `Alert cooldown has to be between ${DEVICE_ALERT_COOLDOWN_MIN_MINUTES} and ${DEVICE_ALERT_COOLDOWN_MAX_MINUTES} minutes. It is at most one “not reporting” email per board in that many minutes.`,
};

const MAP_MISMATCH_GENERIC =
  "The button map selects a court this box does not drive. Give the box more courts, or change the button map first.";

function describeMapMismatch(payload: Record<string, unknown>): string {
  const index = typeof payload.court_index === "number" ? payload.court_index : null;
  const count = typeof payload.device_court_count === "number" ? payload.device_court_count : null;
  const box = typeof payload.device_code === "string" ? payload.device_code : null;
  if (index === null || count === null || box === null) return MAP_MISMATCH_GENERIC;
  const relay = RELAYS[index] ?? `#${index + 1}`;
  const plural = count === 1 ? "" : "s";
  return `The button map selects court ${relay}, but ${box} drives only ${count} court${plural}. `
    + "Give the box more courts, or change the button map first.";
}

export function describeDeviceError(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return e instanceof Error && e.message ? e.message : fallback;
  const payload = typeof e.payload === "object" && e.payload !== null ? (e.payload as Record<string, unknown>) : {};
  const code = typeof payload.error === "string" ? payload.error : null;
  if (code === "button_map_selects_court_beyond_device_courts") return describeMapMismatch(payload);
  if (code !== null && code in DEVICE_ERROR_TEXT) return DEVICE_ERROR_TEXT[code];
  if (typeof payload.message === "string" && payload.message) return payload.message;
  return code ? code.replace(/_/g, " ") : fallback;
}
