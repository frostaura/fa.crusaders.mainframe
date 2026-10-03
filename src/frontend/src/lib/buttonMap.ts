/**
 * The button map's grammar and bounds, apart from its editor (R10: a component module that also
 * exported `buttonMapWithinCap` broke fast refresh and was a lint warning). The tokens mirror
 * src/contracts/device-protocol/buttonmap/cases.json, the file the API and the firmware read.
 */

/** The relay bank on a court box, in the order `court_numbers` is indexed. */
export const RELAYS = ["A", "B", "C", "D"] as const;

export const BUTTON_COUNT = 8;

/**
 * The longest a single button may grant, minutes.
 *
 * <p>
 * The relay bank's own timer opens the relay at ninety minutes whatever the grant said,
 * so a button set to more sells darkness — paid for, with no refund and no re-light
 * path. The number is the hardware's, shared by the API (`Services/RelayHardCap.cs`)
 * and the firmware, and pinned between them as `relay_hard_cap_minutes` in
 * `src/contracts/device-protocol/buttonmap/cases.json`. This field offered 240 while
 * the API refused anything over 90, so the only thing the extra range bought an admin
 * was a save that failed after the fact.
 * </p>
 */
export const MAX_GRANT_MINUTES = 90;

export type ActionKind = "court" | "minutes" | "off" | "none";

export function parseAction(wire: string): { kind: ActionKind; value: string } {
  const text = wire.trim().toLowerCase();
  if (text === "off") return { kind: "off", value: "" };
  if (text.startsWith("court:")) return { kind: "court", value: text.slice(6).toUpperCase() };
  if (text.startsWith("minutes:")) return { kind: "minutes", value: text.slice(8) };
  return { kind: "none", value: "" };
}

export function toWire(kind: ActionKind, value: string) {
  if (kind === "court") return `court:${value || "A"}`;
  if (kind === "minutes") return `minutes:${value || "15"}`;
  return kind;
}

/** Whether a grant is one the relay bank can actually deliver. Blank reads as the default 15. */
export function withinCap(detail: string): boolean {
  const minutes = Number(detail || "15");
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= MAX_GRANT_MINUTES;
}

/**
 * Whether every grant in a map is one the relay bank can deliver.
 *
 * <p>
 * Exported so a save button can be held rather than a refusal explained after the
 * round trip: the API applies the same bound, from the same shared constant.
 * </p>
 */
export function buttonMapWithinCap(value: string[]): boolean {
  return value.every((wire) => {
    const { kind, value: detail } = parseAction(wire);
    return kind !== "minutes" || withinCap(detail);
  });
}

/** Pads or trims a map to exactly eight slots, so the editor never shows a ninth button or hides an eighth. */
export function normaliseButtonMap(value: string[]): string[] {
  const padded = [...value];
  while (padded.length < BUTTON_COUNT) padded.push("none");
  return padded.slice(0, BUTTON_COUNT);
}
