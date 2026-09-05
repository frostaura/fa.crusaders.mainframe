import { useMemo } from "react";
import { Input } from "./Button";

/**
 * The eight-slot button-map editor.
 *
 * <p>
 * Shared by the club-wide map on the Devices screen and the per-box override on a
 * device row, so a token this editor writes is one both the API and the firmware
 * accept — the grammar mirrors src/contracts/device-protocol/buttonmap/cases.json,
 * the file both of them read.
 * </p>
 *
 * <p>
 * The label is the PHYSICAL button, always. Button 1 is the one on pin 22 whatever it
 * now does — that is what makes remapping mean anything.
 * </p>
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

type ActionKind = "court" | "minutes" | "off" | "none";

function parseAction(wire: string): { kind: ActionKind; value: string } {
  const text = wire.trim().toLowerCase();
  if (text === "off") return { kind: "off", value: "" };
  if (text.startsWith("court:")) return { kind: "court", value: text.slice(6).toUpperCase() };
  if (text.startsWith("minutes:")) return { kind: "minutes", value: text.slice(8) };
  return { kind: "none", value: "" };
}

function toWire(kind: ActionKind, value: string) {
  if (kind === "court") return `court:${value || "A"}`;
  if (kind === "minutes") return `minutes:${value || "15"}`;
  return kind;
}

/** Whether a grant is one the relay bank can actually deliver. Blank reads as the default 15. */
function withinCap(detail: string): boolean {
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
function normaliseButtonMap(value: string[]): string[] {
  const padded = [...value];
  while (padded.length < BUTTON_COUNT) padded.push("none");
  return padded.slice(0, BUTTON_COUNT);
}

export function ButtonMapEditor({
  value, onChange, disabled, labelPrefix,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Distinguishes editors that share a screen: "" → "Button 1 action", "Court 1 box" → "Court 1 box button 1 action". */
  labelPrefix?: string;
}) {
  const rows = useMemo(() => normaliseButtonMap(value), [value]);
  const name = (index: number, what: string) =>
    `${labelPrefix ? `${labelPrefix} button` : "Button"} ${index + 1} ${what}`;

  function update(index: number, kind: ActionKind, detail: string) {
    const next = [...rows];
    next[index] = toWire(kind, detail);
    onChange(next);
  }

  return (
    <div className="space-y-2">
      {rows.map((wire, index) => {
        const { kind, value: detail } = parseAction(wire);
        return (
          // flex-wrap, and selects that may shrink: eight rows of a fixed-width label plus
          // two intrinsically-sized selects had a min-content of 362 px, which is what made
          // the whole Devices page 410 px wide inside a 375 px phone even after the confirm
          // button stopped forcing 435. A row that can wrap costs a desktop nothing.
          <div key={index} className="flex flex-wrap items-center gap-2">
            <span className="w-20 shrink-0 text-sm text-slate-500">Button {index + 1}</span>

            <select
              aria-label={name(index, "action")}
              className="h-9 min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-sm"
              value={kind}
              disabled={disabled}
              onChange={(e) => update(index, e.target.value as ActionKind, "")}
            >
              <option value="court">Select court</option>
              <option value="minutes">Grant minutes</option>
              <option value="off">Turn off</option>
              <option value="none">Unused</option>
            </select>

            {kind === "court" && (
              <select
                aria-label={name(index, "court")}
                className="h-9 min-w-0 rounded-lg border border-slate-200 bg-white px-2 text-sm"
                value={detail || "A"}
                disabled={disabled}
                onChange={(e) => update(index, "court", e.target.value)}
              >
                {RELAYS.map((c) => <option key={c} value={c}>Court {c}</option>)}
              </select>
            )}

            {kind === "minutes" && (
              <>
                <Input
                  aria-label={name(index, "minutes")}
                  type="number"
                  min={1}
                  max={MAX_GRANT_MINUTES}
                  className="h-9 w-24"
                  value={detail || "15"}
                  disabled={disabled}
                  onChange={(e) => update(index, "minutes", e.target.value)}
                />
                {/* A number input's max does not stop a typed or pasted value, and the
                    save is refused by the API rather than by the browser, so the reason
                    is said here where the number is. */}
                {!withinCap(detail) && (
                  <span className="text-xs text-danger-strong">
                    1–{MAX_GRANT_MINUTES} minutes — the relay cuts the lights at {MAX_GRANT_MINUTES}.
                  </span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
