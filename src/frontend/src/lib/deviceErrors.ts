import { ApiError } from "./api";
import { RELAYS } from "../components/ButtonMapEditor";
import { GATE_KEY_MAX_LENGTH } from "./gateCopy";
import {
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
  court_number_not_found: "One of those court numbers is not a court at this club. Refresh the page and pick the court again — if it is missing, add it under Admin settings.",
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

  // The three tenant numbers, each named with the bound the API holds, because
  // "out of range" alone leaves an admin guessing which end they went past.
  gate_unlock_seconds_out_of_range: `Unlock time has to be between ${GATE_UNLOCK_MIN_SECONDS} and ${GATE_UNLOCK_MAX_SECONDS} seconds. A door never holds the lock open longer than ${GATE_UNLOCK_MAX_SECONDS} seconds whatever is set here.`,
  gate_early_entry_minutes_out_of_range: `Early entry has to be between ${GATE_EARLY_ENTRY_MIN_MINUTES} and ${GATE_EARLY_ENTRY_MAX_MINUTES} minutes.`,
  // Confirmed against the API rather than guessed: this comment used to say the token was
  // inferred from `button_map_invalid`'s shape because the contract never spelt it out.
  gate_access_policy_invalid: "Who may open a door has to be either “Any member in good standing” or “Only a member with a booking”. Pick one and save again.",
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
