import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CaretDown } from "@/components/ui/icons";
import type { ScheduleCourt, ScheduleSlot } from "../../lib/api";
import { cn } from "../../lib/utils";
import { isSlotHead, peakRestricted, slotAt, type TimeSlice } from "../../lib/scheduleGrid";
import { BOOKINGS_COPY, CELL_TEXT, courtChipLabel, slicePriceLine } from "../../lib/bookingsCopy";
import { useGridInteractions } from "../../lib/useGridInteractions";
import { useTicker } from "../../lib/useTicker";
import { SlotCell, type BoardContext } from "../ScheduleCells";

/**
 * The booking grid (design-system.md, Patterns → Booking grid; R1, R2, R6).
 *
 * <ul>
 *   <li><b>A CSS grid with real gaps</b> — 4px between rows, 6px between courts — and no cell
 *   margins, so every edge lines up (R1) and every slot stands apart (R2).</li>
 *   <li><b>One scroller, both axes</b>, so the court header row sticks to the top and the time
 *   column to the left. Its height is measured chrome, in pixels, with a pixel floor (D3-B10):
 *   a `rem` reserve grows with the text while the viewport does not.</li>
 *   <li><b>A tin now-line</b> across today's grid, the club crest's red, with its dot and caption
 *   in the time column — the one place the crest red appears outside the crest.</li>
 *   <li><b>On a phone the courts stay side by side</b> (members compare courts at one time) with
 *   column snap and, when they do not all fit, a row of court chips that jump to one.</li>
 * </ul>
 */

export type BoardProps = {
  ctx: BoardContext;
  slotsByCourt: Map<string, ScheduleSlot[]>;
  timeSlices: TimeSlice[];
  /** A row is past when its start is `<=` this. Moves in slice steps — see `lib/gridClock`. */
  pastThresholdMs: number;
  peakNowMs: number;
  /** How many leading rows are collapsed behind the "Earlier today" disclosure. */
  collapsedRows: number;
  earlierLabel: string | null;
  onExpandEarlier: () => void;
  /** Draw the now-line: the grid is showing the club's today. */
  showNow: boolean;
};

export const GRID_HEADING_ID = "bookings-grid-heading";

/** Sticky layers, per the z scale: time column 10 · court headers 20 · their corner 25. */
const HEADER_CELL = "sticky top-0 z-sticky bg-bg-surface";

export function BookingBoard(props: BoardProps) {
  const { ctx, timeSlices, collapsedRows, earlierLabel, onExpandEarlier, pastThresholdMs } = props;
  const { day } = ctx;
  const firstLive = firstLiveIndex(timeSlices, collapsedRows, pastThresholdMs);
  const { scroller, gridRef, chips } = useBoardScroll(firstLive, `${day.date}|${collapsedRows}`, day.courts.length);
  const interactions = useGridInteractions({
    gridRef, selection: ctx.selection, rowCount: timeSlices.length, colCount: day.courts.length,
    firstRow: collapsedRows, initialRow: firstLive < 0 ? collapsedRows : firstLive,
  });

  // Rows: 1 = court headers, 2 = the "Earlier today" disclosure when there is one, then the day.
  const bodyStart = earlierLabel ? 3 : 2;
  const lineOf = useCallback((rowIndex: number) => bodyStart + rowIndex - collapsedRows, [bodyStart, collapsedRows]);
  const bodyRows = Math.max(0, timeSlices.length - collapsedRows);


  const style = { "--courts": day.courts.length } as CSSProperties;
  return (
    <div className="flex flex-col gap-3">
      {chips.overflow ? <CourtChips courts={day.courts} active={chips.active} onPick={chips.jump} /> : null}
      <div className="overflow-hidden rounded-xl border border-border bg-bg-surface shadow-xs">
        <div
          ref={scroller}
          data-grid-scroller=""
          className="snap-x snap-proximity overflow-auto overscroll-contain md:snap-none"
          style={{ maxHeight: scrollerMaxHeight(ctx.selection.active) }}
        >
          <div
            ref={gridRef}
            role="grid"
            aria-labelledby={GRID_HEADING_ID}
            aria-multiselectable="true"
           
            onKeyDown={interactions.onKeyDown}
            onFocus={interactions.onFocus}
            onPointerDown={interactions.onPointerDown}
            onPointerOver={interactions.onPointerOver}
            onClickCapture={interactions.onClickCapture}
            style={style}
            className={cn(
              "relative grid w-max min-w-full gap-x-1.5 gap-y-1 px-2 pb-2",
              "grid-cols-[48px_repeat(var(--courts),minmax(104px,1fr))] md:grid-cols-[64px_repeat(var(--courts),minmax(120px,1fr))]",
              // A marquee would otherwise paint a text selection across every court name it crosses.
              "select-none",
            )}
          >
            <HeaderRow courts={day.courts} sliceMinutes={day.sliceMinutes}
              yourRate={ctx.rules.known && ctx.rules.groups.length > 0 && !ctx.rules.adminExempt} />
            {earlierLabel ? <EarlierRow label={earlierLabel} onExpand={onExpandEarlier} /> : null}
            {bodyRows > 0 ? (
              <div aria-hidden="true" style={{ gridRow: `${bodyStart} / span ${bodyRows}`, gridColumn: 1 }}
                className="sticky left-0 z-raised -ml-2 -mr-1.5 border-r border-border bg-bg-surface" />
            ) : null}
            <GridRows
              ctx={ctx} slotsByCourt={props.slotsByCourt} timeSlices={timeSlices}
              pastThresholdMs={pastThresholdMs} peakNowMs={props.peakNowMs} collapsedRows={collapsedRows}
              stopRow={interactions.stop.row} stopCol={interactions.stop.col} lineOf={lineOf}
            />
            {props.showNow ? <NowLine timeSlices={timeSlices} fromRow={collapsedRows} lineOf={lineOf} sliceMinutes={day.sliceMinutes} /> : null}
          </div>
          {timeSlices.length === 0 ? <p className="p-6 text-sm text-text-secondary">{BOOKINGS_COPY.noHours}</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The scroller's ceiling: the viewport less the measured top bar, the phone's tab bar and the
 * page's own bottom padding — never below 280px, so a phone at a 32px root font still has a grid
 * to scroll rather than a slit (D3-B10). Pixels, because what it reserves is pixels of chrome.
 *
 * <p>
 * <b>Sized so the whole grid fits when the page is scrolled to its end.</b> The reserve was 24px
 * against the page shell's 40px bottom padding, so at the page's end the court header row sat
 * 16px above the page's scroll edge; in selection mode the 64px room kept for the floating bar
 * pushed it a further 64px out, and the court names vanished exactly while slots were being
 * picked (measured at the P3/P4 integration: grid top 56px above the scroll edge at 1440px).
 * The selection room is reserved here too, so the grid shrinks by what the bar needs.
 * </p>
 */
/** The page shell's `pb-10`, plus the grid frame's 1px top and bottom borders. */
const PAGE_BOTTOM_PX = 42;
export const SELECTION_ROOM_PX = 64;

function scrollerMaxHeight(selecting: boolean): string {
  const reserve = PAGE_BOTTOM_PX + (selecting ? SELECTION_ROOM_PX : 0);
  return `max(280px, calc(100dvh - var(--app-chrome-height, 56px) - var(--app-bottom-bar-height, 0px) - ${reserve}px))`;
}

function firstLiveIndex(slices: TimeSlice[], from: number, pastThresholdMs: number): number {
  return slices.findIndex((t, i) => i >= from && Date.parse(t.utc) > pastThresholdMs);
}

/** The heading the grid is named by — `sr-only`, because the court names are already visible. */
export function BookingGridHeading() {
  return <h2 id={GRID_HEADING_ID} className="sr-only">{BOOKINGS_COPY.gridHeading}</h2>;
}

function HeaderRow({ courts, sliceMinutes, yourRate }: { courts: ScheduleCourt[]; sliceMinutes: number; yourRate: boolean }) {
  return (
    <div role="row" style={{ display: "contents" }}>
      {/* One sticky backdrop under the whole header row, reaching over the row gap below it, so
          rows scrolling up never show through the gaps between the court headers. */}
      <div aria-hidden="true" style={{ gridRow: 1, gridColumn: "1 / -1" }}
        className="sticky top-0 z-sticky -mx-2 -mb-1 border-b border-border bg-bg-surface" />
      <div role="columnheader" aria-label={BOOKINGS_COPY.timeHeader} style={{ gridRow: 1, gridColumn: 1 }}
        className="sticky left-0 top-0 z-sticky-corner -ml-2 -mr-1.5 bg-bg-surface" />
      {courts.map((c, i) => (
        <div key={c.id} role="columnheader" data-court-col={i} style={{ gridRow: 1, gridColumn: i + 2 }}
          className={cn(HEADER_CELL, "flex min-w-0 snap-start scroll-ml-16 flex-col justify-end px-1 pb-2 pt-3 md:scroll-ml-20")}>
          <span className="truncate text-sm font-semibold text-text-primary">{c.name}</span>
          <span className="text-xs text-text-secondary">
            {c.isActive === false ? CELL_TEXT.idle : slicePriceLine(c.slicePriceCredits, sliceMinutes)}
            {yourRate && c.isActive !== false ? <span className="hidden md:inline">{` · ${BOOKINGS_COPY.yourRate}`}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The past wall, collapsed into one row (D4 §7.4). The rows are not deleted — a member once
 * paid for 03:00 on a Sunday and could find it on no screen — they wait behind a real
 * `aria-expanded` button that says what is inside it.
 */
function EarlierRow({ label, onExpand }: { label: string; onExpand: () => void }) {
  return (
    <div role="row" style={{ display: "contents" }}>
      <div role="gridcell" style={{ gridRow: 2, gridColumn: "1 / -1" }} className="sticky left-0">
        <Button variant="ghost" block onClick={onExpand} aria-expanded={false}
          className="justify-start border-dashed border-border font-medium text-text-secondary"
          icon={<CaretDown aria-hidden="true" />}>
          {label}
        </Button>
      </div>
    </div>
  );
}

type RowsProps = Pick<BoardProps, "ctx" | "slotsByCourt" | "timeSlices" | "pastThresholdMs" | "peakNowMs" | "collapsedRows"> & {
  stopRow: number; stopCol: number; lineOf: (row: number) => number;
};

/**
 * The day's rows. Memoised against the board's own churn — the roving stop moves one cell, a
 * dialog opens, the clock ticks the now-line — so only a real change of day, rules or selection
 * repaints two hundred cells.
 */
const GridRows = memo(function GridRows(props: RowsProps) {
  const { ctx, slotsByCourt, timeSlices, pastThresholdMs, peakNowMs, collapsedRows, stopRow, stopCol, lineOf } = props;
  const { day } = ctx;
  return (
    <>
      {timeSlices.map((t, rowIndex) => {
        if (rowIndex < collapsedRows) return null;
        const cellStartMs = Date.parse(t.utc);
        const isPast = cellStartMs <= pastThresholdMs;
        const line = lineOf(rowIndex);
        return (
          <div key={t.utc} role="row" style={{ display: "contents" }}>
            <div role="rowheader" data-time-row={rowIndex} style={{ gridRow: line, gridColumn: 1 }}
              className={cn("sticky left-0 z-raised pr-2 pt-1 text-right text-xs tabular-nums text-text-secondary", t.outOfHours && "italic")}>
              {t.label}
            </div>
            {day.courts.map((c, colIndex) => {
              const slot = slotAt(slotsByCourt, c.id, cellStartMs, day.sliceMinutes);
              return (
                <SlotCell
                  key={c.id}
                  ctx={ctx}
                  court={c}
                  slot={slot}
                  where={`${c.name} at ${t.label}`}
                  startsAtUtc={t.utc}
                  at={{ row: rowIndex, col: colIndex }}
                  line={line}
                  roving={stopRow === rowIndex && stopCol === colIndex}
                  isHead={slot ? isSlotHead(slot, cellStartMs, day.sliceMinutes, rowIndex === collapsedRows) : false}
                  rowsLeft={timeSlices.length - rowIndex}
                  facts={{
                    minuteOfDay: t.minuteOfDay, sliceMinutes: day.sliceMinutes, isPast, outOfHours: t.outOfHours,
                    peakRestricted: peakRestricted(day, t.minuteOfDay, cellStartMs, peakNowMs),
                  }}
                />
              );
            })}
          </div>
        );
      })}
    </>
  );
});

/**
 * The tin now-line: 2px across the courts at the minute it is, with an 8px dot and a "Now"
 * caption in the (sticky) time column. Its own 30s clock, so the grid never repaints for it.
 */
function NowLine(props: { timeSlices: TimeSlice[]; fromRow: number; lineOf: (row: number) => number; sliceMinutes: number }) {
  const { timeSlices, fromRow, lineOf, sliceMinutes } = props;
  const now = useTicker(true, 30_000);
  const sliceMs = sliceMinutes * 60_000;
  const index = timeSlices.findIndex((t) => {
    const start = Date.parse(t.utc);
    return now >= start && now < start + sliceMs;
  });
  if (index < fromRow || index < 0) return null;
  const top = `${((now - Date.parse(timeSlices[index].utc)) / sliceMs) * 100}%`;
  const line = lineOf(index);
  return (
    <>
      <div aria-hidden="true" data-now-line="" style={{ gridRow: line, gridColumn: "2 / -1" }} className="pointer-events-none relative z-base">
        <div className="absolute -left-1.5 right-0 h-0.5 -translate-y-1/2 rounded-full bg-brand-tin" style={{ top }} />
      </div>
      <div aria-hidden="true" style={{ gridRow: line, gridColumn: 1 }} className="pointer-events-none sticky left-0 z-raised">
        {/* A full-width band in the time column, so "Now" replaces the row's time label where
            they meet instead of printing over it. */}
        <span className="absolute -right-1.5 left-0 flex -translate-y-1/2 items-center justify-end gap-1 bg-bg-surface" style={{ top }}>
          <span className="text-xs font-semibold leading-4 text-brand-tin">{BOOKINGS_COPY.nowCaption}</span>
          <span className="size-2 rounded-full bg-brand-tin" />
        </span>
      </div>
    </>
  );
}

/**
 * The scroller's two jobs: open on the first row that has not started, one row back, once per
 * day (D3-B01 — it opened 3 670px above the first bookable slot); and, on a phone whose courts do
 * not all fit, drive the court chips — measured, never a breakpoint guess, with the chip for the
 * court at the left edge reading as current.
 */
function useBoardScroll(firstLive: number, key: string, courts: number) {
  const scroller = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const target = useRef(firstLive);
  // Latest value for the seeding effect, which deliberately does NOT re-run when the clock moves
  // the first live row: a scroller that jerks back to "now" while somebody reads the evening is
  // worse than one that never moved.
  useEffect(() => { target.current = firstLive; });
  useEffect(() => {
    const box = scroller.current;
    const row = gridRef.current?.querySelector<HTMLElement>(`[data-time-row="${target.current}"]`);
    const header = gridRef.current?.querySelector<HTMLElement>("[data-court-col]");
    if (!box || !row) return;
    box.scrollTop = Math.max(0, row.offsetTop - (header?.offsetHeight ?? 0) - (row.offsetHeight + 4));
  }, [key]);

  const [overflow, setOverflow] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return undefined;
    const headers = () => [...(gridRef.current?.querySelectorAll<HTMLElement>("[data-court-col]") ?? [])];
    const measure = () => setOverflow(box.scrollWidth > box.clientWidth + 1);
    const onScroll = () => {
      const all = headers();
      const edge = box.scrollLeft + (all[0]?.offsetLeft ?? 0) + 4;
      const next = all.findIndex((h) => h.offsetLeft + h.offsetWidth / 2 >= edge);
      setActive(next < 0 ? 0 : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => { observer?.disconnect(); box.removeEventListener("scroll", onScroll); };
  }, [courts]);
  const jump = (index: number) => {
    const box = scroller.current;
    const header = gridRef.current?.querySelector<HTMLElement>(`[data-court-col="${index}"]`);
    const first = gridRef.current?.querySelector<HTMLElement>('[data-court-col="0"]');
    if (!box || !header || !first) return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ left: header.offsetLeft - first.offsetLeft, behavior: reduce ? "auto" : "smooth" });
    setActive(index);
  };
  return { scroller, gridRef, chips: { overflow, active, jump } };
}

function CourtChips({ courts, active, onPick }: { courts: ScheduleCourt[]; active: number; onPick: (i: number) => void }) {
  return (
    <div role="group" aria-label={BOOKINGS_COPY.courtChips} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
      {courts.map((c, i) => (
        <Button key={c.id} size="sm" variant={i === active ? "secondary" : "outline"} aria-pressed={i === active}
          aria-label={courtChipLabel(c.name)} onClick={() => onPick(i)} className="shrink-0 rounded-full">
          {c.name}
        </Button>
      ))}
    </div>
  );
}

/** The grid's shape while the day is read — never "Loading…". */
export function BookingGridSkeleton({ courts = 3 }: { courts?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-surface p-2 shadow-xs">
      <div className="grid gap-x-1.5 gap-y-1" style={{ gridTemplateColumns: `48px repeat(${courts}, minmax(0, 1fr))` }}>
        <span />
        {Array.from({ length: courts }, (_, i) => <Skeleton key={`h${i}`} className="mb-1 mt-3 h-8" />)}
        {Array.from({ length: 8 }, (_, r) => [
          <Skeleton key={`t${r}`} className="ml-auto mt-1 h-3 w-8" />,
          ...Array.from({ length: courts }, (_, c) => <Skeleton key={`${r}-${c}`} className="h-12 rounded-md" />),
        ])}
      </div>
    </div>
  );
}
