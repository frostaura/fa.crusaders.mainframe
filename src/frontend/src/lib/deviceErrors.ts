import { ApiError } from "./api";
import { RELAYS } from "../components/ButtonMapEditor";

/**
 * Device refusals, turned into sentences an admin can act on.
 *
 * <p>
 * Shared by the Devices page and the device API key panel rather than living on one of
 * them, because both talk to the same endpoints and a refusal decoded in only one place
 * is a toast reading `court_number_not_found` in the other.
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
