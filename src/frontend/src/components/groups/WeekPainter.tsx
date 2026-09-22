import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../Button";
import { ScrollArea } from "../ScrollArea";
import { cn } from "../../lib/utils";
import { WEEK_IN_READING_ORDER, formatClock, normalise } from "../../lib/groupRules";
import {
  PAINTER_INSTRUCTIONS, dayName, misalignedWindowNote, paintedRunAnnouncement,
  paintedWeekSentence, type PaintedWeek,
} from "../../lib/groupsCopy";
import type { Weekday } from "../../lib/adminApi";
import {
  cellsFromValue, intervalsFromCells, misalignedFaces, rowStarts, sliceInside, type Cells,
} from "./weekGrid";

/**
 * The weekly painter — when may this group book? (GOAL item 3, D3 §6.2)
 *
 * <p>
 * <b>The grid is the secondary interface and the sentence under it is the primary one.</b> A
 * 7 × 64 wall of coloured squares is nothing at all to somebody who cannot see it, so the
 * summary line is generated from the same intervals the cells are drawn from, is wired to the
 * grid with `aria-describedby`, and is what a screen-reader user is actually given. It is not a
 * caption; if it and the grid ever disagree, the grid is the one that is wrong.
 * </p>
 *
 * <p>
 * <b>Everything is reachable by keyboard, and the run is announced ONCE.</b> Twelve
 * `Shift+Down`s are one decision. A live region that says twelve cells is a screen reader
 * somebody switches off, which costs them every other announcement on the page — so the run is
 * accumulated silently and spoken when Shift comes back up.
 * </p>
 *
 * <p>
 * <b>Never colour alone.</b> Every cell carries the word in its accessible name — "allowed",
 * "not allowed", "the club is closed" — plus `aria-selected`; painted cells carry a ring AND a
 * fill, unpainted a dashed border, closed a hatched muted fill. Under `forced-colors: active`
 * every fill is discarded and the names and borders are what remain.
 * </p>
 *
 * <p>
 * <b>It keeps a working copy, and that is deliberate rather than sloppy.</b> A drag across
 * forty cells cannot round-trip through a parent's state forty times, and a parent that
 * re-renders mid-drag would drop the run. The copy is re-seeded whenever a genuinely new
 * `value` arrives from outside and never during a gesture.
 * </p>
 */

export type WeekPainterProps = {
  /** The club's own hours per weekday. The ceiling: nothing outside them is paintable. */
  club: PaintedWeek;
  value: PaintedWeek;
  onChange: (next: PaintedWeek) => void;
  sliceMinutes: number;
  disabled?: boolean;
};

// ---------------------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------------------

/** A run being painted, so it can be spoken once when it ends rather than per cell. */
type Run = { day: Weekday; from: number; to: number; allowed: boolean };

/** Which mode a gesture is in, and what it has covered so far. */
type Gesture = { allowed: boolean; run: Run } | null;

export function WeekPainter({ club, value, onChange, sliceMinutes, disabled = false }: WeekPainterProps) {
  const gridId = useId();
  const summaryId = `${gridId}-summary`;
  const rows = useMemo(() => rowStarts(club, sliceMinutes), [club, sliceMinutes]);

  /*
   * The working copy, in two places on purpose.
   *
   * `cells` is what renders. `cellsRef` is the same thing readable from an event handler, and
   * it exists because a drag across forty cells arrives as forty events that each need the
   * result of the previous one — a handler closed over last render's state would paint one
   * cell and forget it. Refs are written and read only in handlers and effects, never during
   * render, which is what `react-hooks/refs` is about.
   */
  const [cells, setCells] = useState<Cells>(() => cellsFromValue(value, rows, sliceMinutes));
  const cellsRef = useRef<Cells>(cells);
  const gestureRef = useRef<Gesture>(null);

  const [focus, setFocus] = useState<{ day: number; row: number }>({ day: 0, row: 0 });
  const [announcement, setAnnouncement] = useState("");

  const commit = useCallback((next: Cells) => {
    cellsRef.current = next;
    setCells(next);
  }, []);

  /*
   * Re-seed when a genuinely new `value` arrives — a save landing, a different group opened —
   * and NEVER mid-gesture: a parent that re-renders while somebody is dragging must not be
   * able to drop the run under their hand.
   */
  useEffect(() => {
    if (gestureRef.current) return;
    const seeded = cellsFromValue(value, rows, sliceMinutes);
    cellsRef.current = seeded;
    setCells(seeded);
  }, [value, rows, sliceMinutes]);

  const isOpen = useCallback(
    (day: Weekday, start: number) => sliceInside(normalise(club[day] ?? []), start, sliceMinutes),
    [club, sliceMinutes],
  );

  const emit = useCallback(() => {
    onChange(intervalsFromCells(cellsRef.current, rows, sliceMinutes));
  }, [onChange, rows, sliceMinutes]);

  /** Sets one cell, if the club is open then, and widens the run the gesture is drawing. */
  const apply = useCallback((day: Weekday, index: number, allowed: boolean) => {
    const start = rows[index];
    if (disabled || start === undefined || !isOpen(day, start)) return false;
    const flags = [...(cellsRef.current[day] ?? [])];
    flags[index] = allowed;
    commit({ ...cellsRef.current, [day]: flags });
    const gesture = gestureRef.current;
    if (gesture && gesture.run.day === day) {
      gesture.run.from = Math.min(gesture.run.from, start);
      gesture.run.to = Math.max(gesture.run.to, start + sliceMinutes);
    }
    return true;
  }, [commit, disabled, isOpen, rows, sliceMinutes]);

  /** Ends whatever gesture is in flight and speaks its run — once. */
  const endGesture = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    setAnnouncement(paintedRunAnnouncement(gesture.run.day, gesture.run.from, gesture.run.to, gesture.allowed));
    emit();
  }, [emit]);

  // A drag that leaves the grid still has to end, so the listener is on the window. The state
  // it sets is set from an event callback, never synchronously inside the effect.
  useEffect(() => {
    const onUp = () => endGesture();
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [endGesture]);

  const beginAt = (day: Weekday, index: number, erase: boolean) => {
    const start = rows[index];
    if (disabled || start === undefined || !isOpen(day, start)) return;
    const allowed = !erase;
    gestureRef.current = { allowed, run: { day, from: start, to: start + sliceMinutes, allowed } };
    apply(day, index, allowed);
  };

  /** A whole day, or a whole time across the week — set wholesale, then emitted once. */
  const setMany = (targets: Array<{ day: Weekday; index: number }>, allowed: boolean) => {
    if (disabled) return;
    let next = cellsRef.current;
    for (const target of targets) {
      const start = rows[target.index];
      if (start === undefined || !isOpen(target.day, start)) continue;
      const flags = [...(next[target.day] ?? [])];
      flags[target.index] = allowed;
      next = { ...next, [target.day]: flags };
    }
    commit(next);
    onChange(intervalsFromCells(next, rows, sliceMinutes));
  };

  const dayIsFull = (day: Weekday) =>
    rows.every((start, index) => !isOpen(day, start) || cells[day]?.[index] === true)
    && rows.some((start) => isOpen(day, start));

  const painted = intervalsFromCells(cells, rows, sliceMinutes);
  const misaligned = misalignedFaces(value, rows, sliceMinutes);

  const moveFocus = (dayStep: number, rowStep: number, shiftKey: boolean) => {
    let day = focus.day;
    let row = focus.row;
    // Scan past closed cells in the direction of travel rather than landing on one: a grid
    // that parks focus on an inert square is one a keyboard user presses Space at for nothing.
    for (let step = 0; step < Math.max(rows.length, WEEK_IN_READING_ORDER.length) + 1; step += 1) {
      day += dayStep;
      row += rowStep;
      if (day < 0 || day >= WEEK_IN_READING_ORDER.length || row < 0 || row >= rows.length) return;
      if (isOpen(WEEK_IN_READING_ORDER[day], rows[row])) break;
      if (dayStep === 0 && rowStep === 0) return;
    }
    if (!isOpen(WEEK_IN_READING_ORDER[day], rows[row])) return;
    setFocus({ day, row });
    document.getElementById(`${gridId}-${day}-${row}`)?.focus();
    if (!shiftKey) return;
    const weekday = WEEK_IN_READING_ORDER[day];
    if (!gestureRef.current) {
      // The run takes the state of the cell it started from, so Space-then-Shift-Arrow extends
      // what was just painted rather than inverting it halfway down the column.
      const allowed = cellsRef.current[WEEK_IN_READING_ORDER[focus.day]]?.[focus.row] === true;
      gestureRef.current = {
        allowed,
        run: { day: weekday, from: rows[focus.row], to: rows[focus.row] + sliceMinutes, allowed },
      };
    }
    apply(weekday, row, gestureRef.current.allowed);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const steps: Record<string, [number, number]> = {
      ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      moveFocus(step[0], step[1], event.shiftKey);
      return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      const day = WEEK_IN_READING_ORDER[focus.day];
      const now = cellsRef.current[day]?.[focus.row] === true;
      beginAt(day, focus.row, now);
      endGesture();
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">{PAINTER_INSTRUCTIONS}</p>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button" variant="outline" className="min-h-11" disabled={disabled}
          onClick={() => setMany(everyCell(rows), true)}
        >
          All week
        </Button>
        <Button
          type="button" variant="outline" className="min-h-11" disabled={disabled}
          onClick={() => setMany(everyCell(rows).filter((c) => c.day !== "sat" && c.day !== "sun"), true)}
        >
          Weekdays only
        </Button>
        <Button
          type="button" variant="outline" className="min-h-11" disabled={disabled}
          onClick={() => { commit({}); onChange({}); }}
        >
          Clear
        </Button>
      </div>

      <ScrollArea label="Weekly times" tabbable={false}>
        <div
          role="grid"
          aria-label="When may this group book?"
          aria-describedby={summaryId}
          className="min-w-[23rem]"
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (e.key === "Shift") endGesture(); }}
        >
          <div role="row" className="flex">
            <span role="columnheader" className="w-16 shrink-0" />
            {WEEK_IN_READING_ORDER.map((day) => (
              <div role="columnheader" key={day} className="flex-1 px-0.5">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`${dayIsFull(day) ? "Clear" : "Paint"} all of ${dayName(day)}`}
                  onClick={() => setMany(rows.map((_, index) => ({ day, index })), !dayIsFull(day))}
                  className="w-full min-h-11 rounded-lg border border-control text-sm font-medium"
                >
                  {dayName(day).slice(0, 3)}
                </button>
              </div>
            ))}
          </div>

          {rows.map((start, row) => (
            <div role="row" key={start} className="flex">
              <div role="rowheader" className="w-16 shrink-0 px-0.5">
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`${rowIsFull(cells, row, rows, isOpen) ? "Clear" : "Paint"} ${formatClock(start)} on every day`}
                  onClick={() => setMany(
                    WEEK_IN_READING_ORDER.map((day) => ({ day, index: row })),
                    !rowIsFull(cells, row, rows, isOpen),
                  )}
                  className="w-full min-h-11 rounded-lg text-xs tabular-nums text-text-secondary"
                >
                  {formatClock(start)}
                </button>
              </div>
              {WEEK_IN_READING_ORDER.map((day, dayIndex) => {
                const open = isOpen(day, start);
                const on = cells[day]?.[row] === true;
                const focused = focus.day === dayIndex && focus.row === row;
                return (
                  <div
                    key={day}
                    id={`${gridId}-${dayIndex}-${row}`}
                    role="gridcell"
                    aria-selected={open ? on : undefined}
                    aria-disabled={open ? undefined : true}
                    aria-label={`${dayName(day)} ${formatClock(start)}, ${
                      open ? (on ? "allowed" : "not allowed") : "the club is closed"
                    }`}
                    tabIndex={open && focused ? 0 : -1}
                    onFocus={() => setFocus({ day: dayIndex, row })}
                    onMouseDown={(e) => { e.preventDefault(); beginAt(day, row, e.altKey); }}
                    onMouseEnter={() => {
                      if (gestureRef.current) apply(day, row, gestureRef.current.allowed);
                    }}
                    className={cn(
                      "min-h-11 flex-1 mx-0.5 my-0.5 rounded",
                      !open && "border border-dashed border-border bg-bg-muted/50",
                      open && !on && "border border-dashed border-control bg-bg-muted",
                      open && on && "bg-accent-soft ring-2 ring-inset ring-accent-strong",
                      focused && "outline outline-2 outline-offset-1 outline-accent-strong",
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </ScrollArea>

      {/*
        Spoken once, when a run ends. `sr-only` because the same sentence is already on screen
        in the summary below — saying it twice visually is noise, and not saying it at all to a
        screen reader is the control being unusable.
      */}
      <p aria-live="polite" className="sr-only" data-testid="painter-announcement">{announcement}</p>

      <p id={summaryId} className="text-sm font-medium text-text-primary">
        {paintedWeekSentence(painted, club, sliceMinutes)}
      </p>

      {misaligned.length > 0 && (
        <p className="text-sm text-warning-strong">{misalignedWindowNote(misaligned, sliceMinutes)}</p>
      )}

      <ul aria-label="What the colours mean" className="flex flex-wrap gap-4 text-xs text-text-secondary">
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-4 w-4 rounded bg-accent-soft ring-2 ring-inset ring-accent-strong" />
          <span>Allowed</span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-4 w-4 rounded border border-dashed border-control bg-bg-muted" />
          <span>Not allowed</span>
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="inline-block h-4 w-4 rounded border border-dashed border-border bg-bg-muted/50" />
          <span>Club closed</span>
        </li>
      </ul>
    </div>
  );
}

/** Every cell in the grid, for the three shortcut buttons. */
function everyCell(rows: number[]): Array<{ day: Weekday; index: number }> {
  return WEEK_IN_READING_ORDER.flatMap((day) => rows.map((_, index) => ({ day, index })));
}

/** Whether every OPEN cell on one row is already painted — so the label can say what it will do. */
function rowIsFull(
  cells: Cells, row: number, rows: number[], isOpen: (day: Weekday, start: number) => boolean,
): boolean {
  const open = WEEK_IN_READING_ORDER.filter((day) => isOpen(day, rows[row]));
  return open.length > 0 && open.every((day) => cells[day]?.[row] === true);
}
