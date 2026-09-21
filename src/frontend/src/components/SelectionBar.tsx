import { useEffect, useRef } from "react";
import { Button } from "./Button";
import type { ScheduleDay, ScheduleSlot } from "../lib/api";
import { clubClock } from "../lib/clubClock";
import { splitSelection, type SelectionKey } from "../lib/gridSelection";
import { bookButtonLabel, cancelButtonLabel, selectionCount, selectionSpan } from "../lib/bulkCopy";
import { weekdayName } from "../lib/gridCopy";

/**
 * The sticky strip that appears while anything is selected — items 5 and 13.
 *
 * <p>
 * <b>It never covers the last row.</b> The board gains bottom padding equal to this bar's
 * measured height, published as `--selection-bar-height` by a `ResizeObserver` — the same
 * technique `Layout` already uses for `--app-chrome-height`, and deliberately not a guessed
 * constant, which is the defect D3-B10 records having shipped twice.
 * </p>
 *
 * <p>
 * <b>It owns the grid's one polite live region for selection</b> and is deliberately next in
 * DOM order after the grid, so `Tab` out of the roving-tabindex grid lands on the actions
 * rather than walking past them into the page.
 * </p>
 */
export function SelectionBar({ keys, day, slotsByCourt, onClear, onBook, onCancel }: {
  keys: SelectionKey[];
  day: ScheduleDay | null;
  slotsByCourt: Map<string, ScheduleSlot[]>;
  onClear: () => void;
  onBook: () => void;
  onCancel: () => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bar.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const publish = () => document.documentElement.style.setProperty("--selection-bar-height", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty("--selection-bar-height");
    };
  }, []);

  const { free, booked } = splitSelection(keys);
  const span = describeSpan(keys, day, slotsByCourt);

  return (
    <div ref={bar} role="region" aria-label="Selected slots"
      className="sticky bottom-0 z-40 -mx-4 sm:mx-0 border-t border-border bg-bg-surface/95 backdrop-blur px-4 py-3
                 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:rounded-lg sm:border sm:shadow-md">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{selectionCount(free.length, booked.length)}</p>
          {span && <p className="text-xs text-text-secondary truncate">{span}</p>}
        </div>
        <Button variant="ghost" onClick={onClear}>Clear</Button>
        {booked.length > 0 && (
          <Button variant="danger" onClick={onCancel}>{cancelButtonLabel(booked.length)}</Button>
        )}
        {free.length > 0 && (
          <Button variant="primary" onClick={onBook}>{bookButtonLabel(free.length)}</Button>
        )}
      </div>
    </div>
  );
}

/** "Court 1–3 · Tuesday · 18:00–19:45" — the sanity check an admin makes without scrolling. */
function describeSpan(keys: SelectionKey[], day: ScheduleDay | null, slotsByCourt: Map<string, ScheduleSlot[]>): string {
  if (!day || keys.length === 0) return "";
  const { free, booked } = splitSelection(keys);
  const courtIds = new Set<string>();
  const instants: number[] = [];
  for (const f of free) { courtIds.add(f.courtId); instants.push(Date.parse(f.startsAtUtc)); }
  for (const id of booked) {
    for (const [courtId, slots] of slotsByCourt) {
      const hit = slots.find((s) => s.bookingId === id);
      if (hit) { courtIds.add(courtId); instants.push(Date.parse(hit.startsAtUtc)); }
    }
  }
  const names = day.courts.filter((c) => courtIds.has(c.id)).map((c) => c.name);
  if (instants.length === 0) return selectionSpan(names, weekdayName(day.date), null, null);
  const from = clubClock(Math.min(...instants), day.timezone);
  const to = clubClock(Math.max(...instants), day.timezone);
  return selectionSpan(names, weekdayName(day.date), from, to);
}
