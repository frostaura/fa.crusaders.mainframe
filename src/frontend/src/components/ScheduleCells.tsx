import { memo, useEffect, useRef, useState } from "react";
import { ChevronRight, Info, Lock } from "lucide-react";
import { Card } from "./Card";
import type { ScheduleCourt, ScheduleDay, ScheduleSlot } from "../lib/api";
import { cn, formatCredits } from "../lib/utils";
import { isSlotHead, peakRestricted, slotAt, type TimeSlice } from "../lib/scheduleGrid";
import { cellVerdict, type GridReason, type ViewerRules } from "../lib/gridRules";
import {
  CELL_WORD, closedCellLabel, holdCellLabel, holdLiftLabel, pastCellLabel,
  quotaCellLabel, restrictionLabel, unavailableWhy,
} from "../lib/gridCopy";
import { type SelectionApi, pressableAs, selectableAs } from "../lib/gridSelection";

/** What every cell on the board needs to know, carried once rather than threaded per cell. */
export type BoardContext = {
  day: ScheduleDay;
  rules: ViewerRules;
  isAdmin: boolean;
  /**
   * What a cell that cannot be booked says when it is tapped.
   *
   * <p>
   * D4 §2.9: a League-only cell was an inert `div` with an `aria-label` nobody sighted ever
   * hears. A member tapped it and NOTHING happened — no explanation, no announcement, no route
   * to one. Every unavailable-but-explainable state now answers; the one that does not is
   * Past, because there is nothing to say about it.
   * </p>
   */
  explain: (reason: GridReason, where: string) => void;
  onBook: (court: ScheduleCourt, startsAtUtc: string) => void;
  onCancel: (slot: ScheduleSlot, courtName: string) => void;
  onLiftBlock: (blockId: string) => void | Promise<void>;
  /** Multi-select, when an admin has turned it on. Null the rest of the time — items 5 + 13. */
  selection: SelectionApi | null;
};

type GridProps = {
  ctx: BoardContext;
  slotsByCourt: Map<string, ScheduleSlot[]>;
  timeSlices: TimeSlice[];
  /** A row is past when its start is `<=` this. Moves in slice steps — see `lib/gridClock`. */
  pastThresholdMs: number;
  /** "Now" for the peak-advance mirror, rounded up to the minute. */
  peakNowMs: number;
  /** How many leading rows are collapsed behind the "Earlier today" disclosure. */
  collapsedRows: number;
};

const HEADING_ID = "schedule-grid-heading";

/**
 * The board: sticky court headers and the grid under them, in one scroller.
 *
 * <p>
 * <b>D3-B04 — the grid is a grid now.</b> Five of the six cell types were bare `div`s carrying
 * an `aria-label`, and `aria-label` names nothing on an element whose role is `generic`: most
 * screen readers drop it. So "Closed", "Past", "League only", a club hold and another member's
 * booking were all SILENT, on the one screen whose entire meaning is carried by position.
 * `role="grid"` / `row` / `columnheader` / `rowheader` / `gridcell` is what gives every one of
 * them a name — and it is the same structure multi-select needs for `aria-selected`.
 * </p>
 *
 * <p>
 * <b>The row wrapper is `display: contents`</b>, so the children remain grid items of the outer
 * grid and every sticky header, every column width and the whole layout are byte-identical to
 * what they were. It is the role that is new, not the box.
 * </p>
 *
 * <p>
 * <b>D3-B10 — the scroller's height is measured, not guessed.</b> It was
 * `max-h-[calc(100vh-220px)]`; `Layout` publishes `--app-chrome-height` from a `ResizeObserver`
 * precisely because a guessed chrome constant had already shipped as a bug twice, and
 * `SelectionBar` publishes its own the same way so the action strip never covers the last row.
 * </p>
 *
 * <p>
 * <b>And the reserve is in PIXELS, with a pixel floor.</b> Written as `9rem` it measured
 * <b>74 px</b> of visible grid at 320×568 with a 32 px root font — a slit, with the sticky
 * court header intercepting the click on the only row in it. A `rem` reserve scales with the
 * text while the viewport does not, so the bigger the type the less grid there is, which is
 * backwards. What this reserve protects is pixels of chrome, so it is expressed in pixels; the
 * `max(280px, …)` floor is what makes the page scroll instead of the grid vanishing. That is
 * the same rule `ConfirmButton`'s grid states in the other direction: a measurement belongs in
 * the unit of the thing it is measuring, and a word at a 32 px root is twice as wide while a
 * fingertip is not.
 * </p>
 */
export function ScheduleBoard(props: GridProps & { onExpandEarlier: () => void; earlierLabel: string | null }) {
  const { ctx, timeSlices, collapsedRows, onExpandEarlier, earlierLabel } = props;
  const { day } = ctx;
  const scroller = useRef<HTMLDivElement>(null);
  const firstLiveRow = useRef<HTMLDivElement>(null);

  // D3-B01 / D4 §2.2. The grid opened at the top of the club's day: 247 dead cells and
  // 3 670 px above the first slot anybody could book, which is ~4.5 phone screens of
  // scrolling past the word PAST. Seeded once per day, and deliberately not on every
  // repaint — a scroller that jerks back to "now" while somebody is reading the evening
  // is worse than one that never moved.
  useEffect(() => {
    const row = firstLiveRow.current;
    const box = scroller.current;
    if (!row || !box || typeof row.scrollIntoView !== "function") return;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Never "smooth" over three thousand pixels, and never at all under reduce.
    row.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "auto" });
    // Back off one row, so the member can see the boundary they are standing at rather than
    // arriving with "now" flush against the top edge and no sense of what is behind them.
    box.scrollTop = Math.max(0, box.scrollTop - row.offsetHeight);
  }, [day.date, collapsedRows]);

  /**
   * <b>Roving tabindex — the grid is ONE tab stop in selection mode, not two hundred and forty.</b>
   *
   * <p>
   * D3 §4.7. Found by driving it: `Tab` from a ticked cell landed on the NEXT CELL, so reaching
   * the action bar from the keyboard meant tabbing through every remaining slot in the day. The
   * cell itself is the stop rather than the control inside it, so a Past cell and a Closed cell
   * are traversable too — a grid you can only walk through the bookable parts of is a grid a
   * keyboard user cannot read.
   * </p>
   */
  const [roving, setRoving] = useState({ row: 0, col: 0 });
  const rowCount = timeSlices.length;
  const colCount = day.courts.length;

  const onGridKey = (e: React.KeyboardEvent) => {
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      setRoving((p) => ({
        row: Math.min(rowCount - 1, Math.max(collapsedRows, p.row + dr)),
        col: Math.min(colCount - 1, Math.max(0, p.col + dc)),
      }));
    };
    switch (e.key) {
      case "ArrowDown": return move(1, 0);
      case "ArrowUp": return move(-1, 0);
      case "ArrowRight": return move(0, 1);
      case "ArrowLeft": return move(0, -1);
      case "Home": e.preventDefault(); return setRoving((p) => ({ ...p, col: 0 }));
      case "End": e.preventDefault(); return setRoving((p) => ({ ...p, col: colCount - 1 }));
      // Space chooses; Enter is left alone so the control inside the cell keeps its own meaning.
      case " ": {
        e.preventDefault();
        const cell = e.target as HTMLElement;
        (cell.querySelector("button") as HTMLButtonElement | null)?.click();
        return;
      }
      // One Escape drops the choices, a second leaves the mode — so an admin who has ticked
      // twelve cells by mistake does not also lose the mode they are working in.
      case "Escape":
        e.preventDefault();
        return ctx.selection?.count ? ctx.selection.clearAll() : ctx.selection?.leave();
      default: return undefined;
    }
  };

  const columns = `64px repeat(${day.courts.length}, minmax(120px, 1fr))`;
  const selecting = ctx.selection?.active ?? false;
  return (
    <Card className="p-0 overflow-hidden mb-6">
      <div ref={scroller}
        className="overflow-auto max-h-[max(280px,calc(100dvh-var(--app-chrome-height,154px)-var(--selection-bar-height,0px)-96px))]">
        <div role="grid" aria-labelledby={HEADING_ID} aria-multiselectable={ctx.selection ? true : undefined}
          onKeyDown={selecting ? onGridKey : undefined}
          className="grid min-w-[600px]" style={{ gridTemplateColumns: columns }}>
          <HeaderRow courts={day.courts} sliceMinutes={day.sliceMinutes}
            yourRate={ctx.rules.known && ctx.rules.groups.length > 0} />
          {earlierLabel && <EarlierRow label={earlierLabel} span={day.courts.length + 1} onExpand={onExpandEarlier} />}
          {/* Only what the grid actually reads, never `{...props}`: the board's own
              `onExpandEarlier` is an inline arrow from the page, and spreading it in handed the
              memo a new prop on every render — which is the whole of the 28 ms measured for
              opening a dialog that touches no cell at all. */}
          <ScheduleGrid
            ctx={ctx} slotsByCourt={props.slotsByCourt} timeSlices={timeSlices}
            pastThresholdMs={props.pastThresholdMs} peakNowMs={props.peakNowMs}
            collapsedRows={collapsedRows} firstLiveRow={firstLiveRow} startRow={collapsedRows}
            roving={selecting ? roving : null}
          />
          {timeSlices.length === 0 && <div className="col-span-full p-6 text-sm text-text-secondary">This day has no hours to show.</div>}
        </div>
      </div>
    </Card>
  );
}

/** The heading the grid is named by — `sr-only`, because the court names are already visible. */
export function ScheduleGridHeading() {
  return <h2 id={HEADING_ID} className="sr-only">Courts and times</h2>;
}

function HeaderRow({ courts, sliceMinutes, yourRate }: {
  courts: ScheduleCourt[]; sliceMinutes: number; yourRate: boolean;
}) {
  return (
    <div role="row" style={{ display: "contents" }}>
      <div role="columnheader" aria-label="Time" className="sticky top-0 left-0 z-30 bg-bg-surface" />
      {courts.map((c) => (
        <div key={c.id} role="columnheader"
          className="sticky top-0 z-20 bg-bg-surface px-2 py-2 text-xs text-text-secondary text-center border-b border-border">
          <div className="font-medium text-text-primary">{c.name}{c.isActive === false && <span className="font-normal"> · not in use</span>}</div>
          {/* D3-B16: the grid priced a "slice" and never said how long one is. And the price
              is THIS VIEWER's (D2 §4.2) — a member is never shown another group's rate. */}
          <div>{formatCredits(c.slicePriceCredits)} / {sliceMinutes} min{yourRate && <span className="block text-[10px]">your rate</span>}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The past wall, collapsed into one row (D4 §7.4).
 *
 * <p>
 * The rows themselves are NOT deleted. `gridWindow`'s own comment records why: a member was
 * sold 03:00 on a Sunday, the grid began at 06:00, and the booking they had paid for appeared
 * on no screen in the product — they could neither see it, cancel it nor get it back. So they
 * are collapsed behind a real `aria-expanded` button that says what is inside it, and the
 * parenthetical naming the viewer's own bookings is the whole reason it is not merely hidden.
 * </p>
 *
 * <p>
 * `border-control`, not `border-border`: this rule is not a row separator that happens to sit
 * under a button — it IS this control's only visible boundary, because the bar has no other
 * edge. SC 1.4.11 wants 3:1 for that, which is exactly the split the two tokens encode.
 * </p>
 */
function EarlierRow({ label, span, onExpand }: { label: string; span: number; onExpand: () => void }) {
  return (
    <div role="row" style={{ display: "contents" }}>
      <div role="gridcell" style={{ gridColumn: `1 / span ${span}` }}>
        <button type="button" onClick={onExpand} aria-expanded={false}
          className="w-full min-h-[44px] px-3 py-2 flex items-center gap-2 text-left text-xs text-text-secondary bg-bg-muted/40 border-b border-control">
          <ChevronRight size={14} aria-hidden="true" />
          <span>{label}</span>
        </button>
      </div>
    </div>
  );
}

export const ScheduleGrid = memo(function ScheduleGrid(props: GridProps & {
  firstLiveRow: React.RefObject<HTMLDivElement | null>; startRow: number;
  roving: { row: number; col: number } | null;
}) {
  const { ctx, slotsByCourt, timeSlices, pastThresholdMs, peakNowMs, firstLiveRow, startRow, roving } = props;
  const { day } = ctx;
  // The row the scroll is seeded on: the first one that has not started. Computed once rather
  // than latched while mapping — a variable written during render is state, and React may
  // replay a render without replaying the write.
  const firstLiveIndex = timeSlices.findIndex((t, i) => i >= startRow && Date.parse(t.utc) > pastThresholdMs);
  return (
    <>
      {timeSlices.map((t, rowIndex) => {
        if (rowIndex < startRow) return null;
        const cellStartMs = new Date(t.utc).getTime();
        const isPast = cellStartMs <= pastThresholdMs;
        return (
          <GridRow key={t.utc} t={t} rowRef={rowIndex === firstLiveIndex ? firstLiveRow : undefined}>
            {day.courts.map((c, colIndex) => (
              <SlotCell
                key={c.id + t.utc}
                roving={roving ? roving.row === rowIndex && roving.col === colIndex : null}
                ctx={ctx}
                court={c}
                slot={slotAt(slotsByCourt, c.id, cellStartMs, day.sliceMinutes)}
                where={`${c.name} at ${t.label}`}
                isHead={(s) => isSlotHead(s, cellStartMs, day.sliceMinutes, rowIndex === 0)}
                startsAtUtc={t.utc}
                facts={{
                  minuteOfDay: t.minuteOfDay, sliceMinutes: day.sliceMinutes, isPast,
                  outOfHours: t.outOfHours,
                  peakRestricted: peakRestricted(day, t.minuteOfDay, cellStartMs, peakNowMs),
                }}
              />
            ))}
          </GridRow>
        );
      })}
    </>
  );
});

function GridRow({ t, rowRef, children }: {
  t: TimeSlice; rowRef?: React.RefObject<HTMLDivElement | null>; children: React.ReactNode;
}) {
  // `cn`, not a template literal. lizard's .tsx parser reads a bare `<` inside an
  // interpolation as the start of a JSX tag, never finds its close, and swallows the
  // rest of the file into this one function.
  // Never a faded label. `text-text-muted` at 12px is already the worst contrast on this
  // screen (E-F08 measures it at 2.56:1 against white, where AA asks 4.5:1), and the time
  // is the ONLY thing on the grid that says what time a slot is.
  return (
    <div role="row" ref={rowRef} style={{ display: "contents" }}>
      <div role="rowheader" className={cn(
        "sticky left-0 z-10 bg-bg-surface text-xs font-mono border-r border-border",
        "flex items-center justify-end pr-2 text-text-secondary",
        t.outOfHours && "italic",
      )}>
        {t.label}
      </div>
      {children}
    </div>
  );
}

type SlotCellProps = {
  ctx: BoardContext;
  court: ScheduleCourt;
  slot?: ScheduleSlot;
  /**
   * "Court 1 at 06:00" — what this cell IS, carried rather than inferred.
   *
   * <p>
   * The grid conveys court and time by POSITION: a column header and a row label. Position is
   * exactly what a screen reader, or anyone tabbing, cannot perceive — so eleven identically
   * named "Available" buttons were the same button as far as assistive tech was concerned.
   * </p>
   */
  where: string;
  isHead: (slot: ScheduleSlot) => boolean;
  startsAtUtc: string;
  facts: { minuteOfDay: number; sliceMinutes: number; isPast: boolean; outOfHours: boolean; peakRestricted: boolean };
  /** True on the one cell that is the grid's tab stop; null outside selection mode. */
  roving?: boolean | null;
};

export function SlotCell(props: SlotCellProps) {
  const { ctx, slot, isHead, where } = props;
  if (!slot) return <EmptyCell {...props} />;
  // Only the booking's first cell carries its name and controls. Every later cell of the same
  // booking is a continuation — which is what makes a 60-minute booking read as one block
  // rather than four identical buttons, and stops a member being offered "cancel" four times.
  if (!isHead(slot)) return <ContinuationCell slot={slot} where={where} roving={props.roving} />;
  if (slot.status === "adminblock") return <HoldCell {...props} slot={slot} />;
  if (slot.isMine) return <MyCell {...props} slot={slot} />;
  return <OtherCell {...props} slot={slot} ctx={ctx} />;
}

/**
 * One cell of the grid, whatever is inside it.
 *
 * <p>
 * The wrapper is what carries `role="gridcell"` and, in selection mode, `aria-selected` — so a
 * cell's selectedness is a property of the CELL rather than of whichever control happens to be
 * inside it, and D3-B04's five silent types each get a name in one place.
 * </p>
 *
 * <p>
 * <b>The name is the cell's POSITION when a control is inside it, and the whole story when
 * nothing is.</b> A `gridcell` does allow name-from-content in the ARIA spec, but it is not
 * computed for an authored role by the accname implementation this repo tests with — so "every
 * cell is named" would otherwise be a claim no test could check. Labelling both the cell and
 * its button with the same sentence would instead make one cell answer to two elements, which
 * is a different defect: `getByLabelText` finding two nodes is a screen reader hearing the
 * sentence twice. So the cell says where it is and the control says what it does.
 * </p>
 */
function Cell({ label, selectKey, selection, roving, children }: {
  label: string; selectKey?: string | null; selection?: SelectionApi | null;
  /** Roving tabindex: `true` on the ONE cell that is the grid's tab stop. Null outside selection mode. */
  roving?: boolean | null;
  children: React.ReactNode;
}) {
  const selected = selectKey && selection ? selection.isSelected(selectKey) : undefined;
  const ref = useRef<HTMLDivElement>(null);
  // Focus follows the roving index rather than the pointer, which is what makes the arrow keys
  // move a visible caret rather than silently changing a number.
  useEffect(() => { if (roving && document.activeElement !== ref.current) ref.current?.focus(); }, [roving]);
  // And while the CELL is the tab stop, whatever is inside it must not be one as well —
  // otherwise the grid is 240 tab stops plus a roving index, which is worse than either. Done
  // here rather than by threading a `tabIndex` prop through six cell variants, so a seventh
  // variant cannot forget it. `roving == null` is "not in selection mode", where the controls
  // keep their ordinary place in the tab order.
  useEffect(() => {
    const inner = ref.current?.querySelectorAll<HTMLElement>("button,a[href],input,select,textarea");
    inner?.forEach((el) => { el.tabIndex = roving == null ? 0 : -1; });
  }, [roving, children]);
  return (
    <div ref={ref} role="gridcell" aria-label={label} tabIndex={roving == null ? undefined : (roving ? 0 : -1)}
      aria-selected={selection && selectKey ? Boolean(selected) : undefined}
      className={cn("relative outline-none", selected && "ring-2 ring-inset ring-accent-strong rounded-md",
        roving && "ring-2 ring-offset-1 ring-accent-strong rounded-md")}>
      {children}
      {selected && (
        <span aria-hidden="true"
          className="absolute top-1 right-1 h-4 w-4 rounded-full bg-accent-strong text-white text-[10px] leading-4 text-center">
          ✓
        </span>
      )}
    </div>
  );
}

function EmptyCell(props: SlotCellProps) {
  const { ctx, court, where, startsAtUtc, facts } = props;
  const verdict = cellVerdict(ctx.rules, facts);
  const target = { kind: "free", courtId: court.id, startsAtUtc } as const;
  const selectKey = selectableAs(ctx.selection, target, verdict.bookable);
  const armKey = pressableAs(ctx.selection, target, verdict.bookable);

  if (verdict.reason === "past_time") {
    return <Cell label={pastCellLabel(where)} roving={props.roving}>{inert("bg-bg-muted/60 border border-border uppercase tracking-wide font-medium", CELL_WORD.past)}</Cell>;
  }
  if (verdict.reason !== null) {
    return <Cell label={where} roving={props.roving}><UnavailableCell reason={verdict.reason} where={where} ctx={ctx} /></Cell>;
  }
  if (court.isActive === false) {
    return <Cell label={`${where} — this court is not in use`} roving={props.roving}>{inert("bg-bg-muted/40 border border-dashed border-border", "Not in use")}</Cell>;
  }

  // The parameter used to be called priceZar and rendered with a rand sign. The name was the
  // tell: it is a credit price, and at 1.6–2.4 credits per rand the grid was quoting a court
  // at well under half what it costs.
  const price = formatCredits(court.slicePriceCredits);
  return (
    <Cell label={where} selectKey={selectKey} selection={ctx.selection} roving={props.roving}>
      <button
        type="button"
        onClick={() => (selectKey ? ctx.selection?.toggle(selectKey) : ctx.onBook(court, startsAtUtc))}
        onPointerDown={armKey ? ctx.selection?.armLongPress(armKey) : undefined}
        aria-label={`Book ${where} for ${price}`}
        className="w-full m-0.5 h-12 rounded-md bg-success-soft text-success-strong hover:bg-success-soft/70 text-xs font-medium"
      >
        {CELL_WORD.available}
      </button>
    </Cell>
  );
}

/** A cell that exists, is not this viewer's to take, and says why when it is tapped. */
function UnavailableCell({ reason, where, ctx }: { reason: GridReason; where: string; ctx: BoardContext }) {
  const quota = isQuota(reason);
  const closed = reason === "out_of_hours";
  const word = unavailableWord(reason, ctx.rules);
  const label = unavailableLabel(reason, where, ctx.rules);
    // An ordinary, ENABLED button — and this is a deliberate departure from D4 §7.1, which asked
  // for `aria-disabled="true"`.
  //
  // D4's reason for preferring it to `disabled` was that the cell must stay focusable, so a
  // keyboard or screen-reader user can reach it and be told why; a `disabled` button is a hole
  // in the tab order that explains nothing, which is the dead surface D4 §2.9 measured. That
  // reasoning stands. `aria-disabled` is simply not what achieves it: it asserts "present but
  // NOT OPERABLE", and this control is operable — pressing it is the whole point, it just does
  // not book. The accessible name already carries the refusal ("Court 1 at 16:00 — reserved for
  // league and senior members until closer to the time"), which is a great deal clearer than a
  // dimmed state a reader announces as "unavailable".
  //
  // Found by driving it: Playwright refuses to click an `aria-disabled` button at all
  // ("element is not enabled"). Automation and assistive technology read that attribute the
  // same way, so the attribute was about to make the cell unreachable for exactly the users it
  // was added for.
  return (
    <button
      type="button"
      onClick={() => ctx.explain(reason, where)}
      aria-label={label}
      className={cn(
        "w-full m-0.5 h-12 rounded-md flex items-center justify-center gap-1 text-center text-[11px] leading-tight px-1 no-lift",
        // Colour is never the only carrier (SC 1.4.1): every one of these differs by BORDER
        // STYLE, GLYPH and WORD as well as fill, so all five survive forced-colors and
        // greyscale. D4 §7.3 is the table this implements.
        closed && "bg-bg-muted/40 border border-dashed border-border text-text-secondary",
        quota && "bg-bg-muted border border-dashed border-control text-text-secondary font-medium",
        !closed && !quota && "bg-warning-soft/50 border border-dashed border-warning-strong/30 text-warning-strong",
      )}
    >
      {quota && <Lock size={11} aria-hidden="true" />}
      {!closed && !quota && <Info size={11} aria-hidden="true" />}
      {word}
    </button>
  );
}

function inert(tone: string, text: string) {
  return <div className={cn("m-0.5 h-12 rounded-md text-text-secondary flex items-center justify-center text-[11px]", tone)}>{text}</div>;
}

/**
 * A club hold — item 14's plan occurrences and the admin's own one-off blocks.
 *
 * <p>
 * D3 §5.6: the label is the PLAN's name, never the word "Blocked", because a hold nobody can
 * name is a hold nobody can ask about; and a second line says "Club hold" so a member knows it
 * is the club rather than another member. D3-B11: the lift control was a 10 px underlined word
 * inside a 48 px cell — the smallest destructive target in the product.
 * </p>
 */
function HoldCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts } = props;
  const selectKey = selectableAs(ctx.selection, { kind: "booked", bookingId: slot.bookingId ?? "" }, !facts.isPast && Boolean(slot.bookingId));
  const body = (
    <span className="flex flex-col items-center leading-tight min-w-0">
      <span className="truncate max-w-full">{slot.blockLabel ?? "Club hold"}</span>
      {slot.blockLabel && <span className="text-[10px] text-text-secondary">{CELL_WORD.hold}</span>}
    </span>
  );
  const shell = "m-0.5 h-12 rounded-md border border-transparent bg-bg-muted bg-[repeating-linear-gradient(45deg,_rgba(0,0,0,0.04)_0,_rgba(0,0,0,0.04)_4px,_transparent_4px,_transparent_8px)] flex items-center justify-center gap-1 text-xs text-text-secondary px-1";
  if (selectKey) {
    return (
      <Cell label={where} selectKey={selectKey} selection={ctx.selection} roving={props.roving}>
        <button type="button" className={cn(shell, "w-full")} aria-label={holdCellLabel(where, slot.blockLabel)}
          onClick={() => ctx.selection?.toggle(selectKey)}>{body}</button>
      </Cell>
    );
  }
  // The lift control's own name ("Lift the League night hold on Court 2 at 18:00") is a
  // different sentence from the cell's, so the cell can carry the whole story here without one
  // cell answering to two labels.
  const liftable = ctx.isAdmin && slot.bookingId && !facts.isPast;
  return (
    <Cell label={holdCellLabel(where, slot.blockLabel)} roving={props.roving}>
      <div className={shell}>
        {body}
        {liftable && (
          <button
            type="button"
            className="shrink-0 h-11 w-11 -my-1 flex items-center justify-center text-[10px] underline no-lift"
            onClick={() => ctx.onLiftBlock(slot.bookingId!)}
            aria-label={holdLiftLabel(where, slot.blockLabel)}
          >
            lift
          </button>
        )}
      </div>
    </Cell>
  );
}

/** A later cell of a booking that started earlier. Reserved, and visibly the same booking. */
function ContinuationCell({ slot, where, roving }: { slot: ScheduleSlot; where: string; roving?: boolean | null }) {
  const tone = slot.isMine ? "bg-info-soft/60 text-info-strong" : "bg-bg-muted text-text-secondary";
  return (
    <Cell label={slot.isMine ? `${where} — continues, your booking` : `${where} — continues, reserved`} roving={roving}>
      {/* `border border-transparent`, the house rule from `index.css`'s forced-colors block and
          from `BUTTON_VARIANT_CLASS.ghost`: under `forced-colors: active` every author
          background is thrown away, so a cell whose only boundary is its fill becomes bare text
          in an empty box. Measured: this one and the Taken cell below were the two on the grid
          computing `border: 0px`. A transparent 1 px border is already in the box model, so
          nothing moves. */}
      <div className={cn("m-0.5 h-12 rounded-md border border-transparent flex items-center justify-center text-[11px]", tone)} aria-hidden="true">⋯</div>
    </Cell>
  );
}

function MyCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, court } = props;
  // Attendance, on screen at last. The schedule projection did not carry it, so no screen in
  // the product could tell a member their court was lit — which is also why the cancel
  // affordance could not warn that nothing would come back.
  const label = slot.checkedIn ? "Mine · checked in" : "Mine";
  const target = { kind: "booked", bookingId: slot.bookingId ?? "" } as const;
  const pickable = !facts.isPast && Boolean(slot.bookingId);
  const selectKey = selectableAs(ctx.selection, target, pickable);
  const armKey = pressableAs(ctx.selection, target, pickable);
  if (facts.isPast || !slot.bookingId) {
    return (
      <Cell label={slot.checkedIn ? `${where} — your past booking, attended` : `${where} — your past booking`} roving={props.roving}>
        <div className="m-0.5 h-12 rounded-md bg-info-soft/60 text-info-strong border border-info-soft flex items-center justify-center text-xs font-medium text-center px-1">
          {slot.checkedIn ? "Mine · played" : "Mine · past"}
        </div>
      </Cell>
    );
  }
  const mineLabel = slot.checkedIn ? `Cancel your booking on ${where} — checked in` : `Cancel your booking on ${where}`;
  return (
    <Cell label={where} selectKey={selectKey} selection={ctx.selection} roving={props.roving}>
      <button
        type="button"
        onClick={() => (selectKey ? ctx.selection?.toggle(selectKey) : ctx.onCancel(slot, court.name))}
        onPointerDown={armKey ? ctx.selection?.armLongPress(armKey) : undefined}
        aria-label={mineLabel}
        className={cn(
          "w-full m-0.5 h-12 rounded-md text-xs font-medium px-1 text-center",
          slot.checkedIn ? "bg-warning-soft text-warning-strong hover:bg-warning-soft/70" : "bg-info-soft text-info-strong hover:bg-info-soft/80",
        )}
      >
        {label}
      </button>
    </Cell>
  );
}

function OtherCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, court } = props;
  // "The booking grid shows photo + name only" — no email, phone or membership number.
  const body = (
    <>
      {slot.ownerPhotoUrl ? (
        <img src={slot.ownerPhotoUrl} alt="" style={{ width: 34, height: 34 }} className="rounded-full object-cover ring-2 ring-bg-surface shadow-sm shrink-0" />
      ) : (
        <div style={{ width: 34, height: 34 }} className="rounded-full bg-bg-surface border border-border flex items-center justify-center text-sm font-medium ring-2 ring-bg-surface shadow-sm shrink-0">
          {slot.ownerFirstName?.[0] ?? "?"}
        </div>
      )}
      <span className="truncate">{slot.ownerFirstName ?? "Reserved"}</span>
      {slot.checkedIn && <span className="text-[10px] text-success-strong shrink-0">on court</span>}
    </>
  );
  // See the note on `ContinuationCell`: `border border-transparent` is what survives
  // `forced-colors: active`, where this cell's grey fill does not.
  const shell = "m-0.5 h-12 w-[calc(100%-0.25rem)] rounded-md border border-transparent bg-bg-muted text-text-secondary flex items-center justify-center gap-2 text-xs px-1";
  const target = { kind: "booked", bookingId: slot.bookingId ?? "" } as const;
  const pickable = ctx.isAdmin && !facts.isPast && Boolean(slot.bookingId);
  const selectKey = selectableAs(ctx.selection, target, pickable);
  const armKey = pressableAs(ctx.selection, target, pickable);

  // §8: an admin can cancel any booking on behalf of any member, penalty waiveable. The
  // endpoint has always existed; another member's slot was inert text with no way to reach it,
  // so a club running the desk had to go to the database.
  const otherLabel = `${slot.ownerFirstName ?? "Reserved"} — cancel on their behalf, ${where}`;
  if (ctx.isAdmin && slot.bookingId && !facts.isPast) {
    return (
      <Cell label={where} selectKey={selectKey} selection={ctx.selection} roving={props.roving}>
        <button
          type="button"
          onClick={() => (selectKey ? ctx.selection?.toggle(selectKey) : ctx.onCancel(slot, court.name))}
          onPointerDown={armKey ? ctx.selection?.armLongPress(armKey) : undefined}
          aria-label={otherLabel}
          className={cn(shell, "hover:bg-bg-muted/70")}
        >
          {body}
        </button>
      </Cell>
    );
  }
  return (
    <Cell label={`${where} — booked by ${slot.ownerFirstName ?? "another member"}`} roving={props.roving}>
      <div className={cn(shell, "overflow-visible")} aria-hidden="true">{body}</div>
    </Cell>
  );
}


/** True when the reason is the member's own daily maximum rather than a fact about the slot. */
function isQuota(reason: GridReason): boolean {
  return reason === "per_day_slot_cap" || reason === "per_day_minute_cap";
}

/** The short word an unavailable cell wears — see D4 §7.3's table. */
function unavailableWord(reason: GridReason, rules: ViewerRules): string {
  if (reason === "out_of_hours") return CELL_WORD.closed;
  if (isQuota(reason)) return CELL_WORD.full;
  return restrictionLabel(reason, rules.allowedWindows ?? []);
}

/**
 * The cell's accessible name.
 *
 * <p>
 * Carried on the `gridcell` itself rather than left to be computed from its contents. A
 * `gridcell` does allow name-from-content in the ARIA spec, but the computation is not
 * reliable across screen readers for an element whose role is authored rather than implicit —
 * and it is measurably not computed by the accname implementation this repo tests with, which
 * means "the cell is named" would have been a claim no test could check.
 * </p>
 */
function unavailableLabel(reason: GridReason, where: string, rules: ViewerRules): string {
  if (reason === "out_of_hours") return closedCellLabel(where);
  if (isQuota(reason)) return quotaCellLabel(where, rules.maxSlotsPerDay ?? 0);
  return `${where} — ${unavailableWhy(reason)}`;
}
