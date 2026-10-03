import { useMemo } from "react";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { cn } from "@/lib/utils";
import { normaliseButtonMap, parseAction, RELAYS, toWire, withinCap, type ActionKind, MAX_GRANT_MINUTES } from "@/lib/buttonMap";

/** A select that takes its row and wraps its value at spaces (R10 L10-5) until the box is wide enough to share one. */
const WRAPS = cn(
  "w-full min-w-0 whitespace-normal [&_[data-slot=select-value]]:line-clamp-none",
  // A phone at 200 % text: "minutes" is wider than a 1rem-inset box leaves, so under 12rem the
  // inset, the gap and the type step down (a button takes no focus zoom; `sm:text-sm` is unchanged).
  "gap-1 px-2 text-sm @[12rem]/bmap:gap-2 @[12rem]/bmap:px-3 @[12rem]/bmap:text-base",
);

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
    // R10 L10-5: decided by the editor's own BOX in rem (`@container/bmap`), never `sm:` — at 390 /
    // 200 % text the two selects shared a row and showed "Select c", "Grant m". Under 20rem each
    // control takes its own row; 20–28rem the label sits above the two selects side by side; from
    // 28rem the row is label · action · court on one line. A value wraps at its spaces, never cut.
    <div className="@container/bmap flex flex-col divide-y divide-border rounded-lg border border-border bg-bg-surface">
      {rows.map((wire, index) => {
        const { kind, value: detail } = parseAction(wire);
        return (
          // flex-wrap, and controls that may shrink: eight rows of a fixed-width label plus
          // two intrinsically-sized controls had a min-content of 362 px, which is what made
          // the whole Devices page 410 px wide inside a 375 px phone. A row that can wrap costs
          // a desktop nothing.
          <div key={index} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-2 @[12rem]/bmap:px-3">
            <span className="w-full shrink-0 text-sm font-medium text-text-secondary @[28rem]/bmap:w-20">Button {index + 1}</span>

            <Select value={kind} disabled={disabled} onValueChange={(next) => update(index, next as ActionKind, "")}>
              <SelectTrigger aria-label={name(index, "action")} className={cn(WRAPS, "@[20rem]/bmap:w-auto @[20rem]/bmap:flex-[1_1_9rem] @[28rem]/bmap:w-44 @[28rem]/bmap:flex-none")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="court">Select court</SelectItem>
                <SelectItem value="minutes">Grant minutes</SelectItem>
                <SelectItem value="off">Turn off</SelectItem>
                <SelectItem value="none">Unused</SelectItem>
              </SelectContent>
            </Select>

            {kind === "court" && (
              <Select value={detail || "A"} disabled={disabled} onValueChange={(next) => update(index, "court", next)}>
                <SelectTrigger aria-label={name(index, "court")} className={cn(WRAPS, "@[20rem]/bmap:w-auto @[20rem]/bmap:flex-[1_1_7rem] @[28rem]/bmap:w-32 @[28rem]/bmap:flex-none")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELAYS.map((c) => <SelectItem key={c} value={c}>{`Court ${c}`}</SelectItem>)}
                </SelectContent>
              </Select>
            )}

            {kind === "minutes" && (
              <>
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Input
                    aria-label={name(index, "minutes")}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_GRANT_MINUTES}
                    className="w-24 min-w-0 tabular-nums"
                    value={detail || "15"}
                    disabled={disabled}
                    aria-invalid={!withinCap(detail) || undefined}
                    onChange={(e) => update(index, "minutes", e.target.value)}
                  />
                  <span className="text-sm text-text-secondary">min</span>
                </span>
                {/* A number input's max does not stop a typed or pasted value, and the
                    save is refused by the API rather than by the browser, so the reason
                    is said here where the number is. */}
                {!withinCap(detail) && (
                  <span className="text-sm text-danger-strong">
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
