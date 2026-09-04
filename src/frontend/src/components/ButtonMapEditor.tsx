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
          <div key={index} className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-sm text-slate-500">Button {index + 1}</span>

            <select
              aria-label={name(index, "action")}
              className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"
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
                className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-sm"
                value={detail || "A"}
                disabled={disabled}
                onChange={(e) => update(index, "court", e.target.value)}
              >
                {RELAYS.map((c) => <option key={c} value={c}>Court {c}</option>)}
              </select>
            )}

            {kind === "minutes" && (
              <Input
                aria-label={name(index, "minutes")}
                type="number"
                min={1}
                max={240}
                className="h-9 w-24"
                value={detail || "15"}
                disabled={disabled}
                onChange={(e) => update(index, "minutes", e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
