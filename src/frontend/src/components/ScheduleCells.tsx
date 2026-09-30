import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { Interactable } from "@/components/ui/interactable";
import { Check, Gauge, Info, LockOpen } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import type { ScheduleCourt, ScheduleDay, ScheduleSlot } from "../lib/api";
import { cn, formatCredits } from "../lib/utils";
import { cellVerdict, type CellFacts, type GridReason, type ViewerRules } from "../lib/gridRules";
import { closedCellLabel, holdCellLabel, holdLiftLabel, pastCellLabel, quotaCellLabel, restrictionLabel, unavailableWhy } from "../lib/gridCopy";
import {
  CELL_TEXT, PARTNER_CELL_WORD, PENDING_CELL, bookCellLabel, bookedByLabel, continuesLabel, idleCellLabel,
  mineCellLabel, minePastCellLabel, otherCellAdminLabel, partnerCellLabel,
} from "../lib/bookingsCopy";
import { isPartnerSlot } from "../lib/bookingsApi";
import {
  bookedKey, isPendingBooking, selectionKey, type GridCoord, type SelectionApi, type SelectionKey,
} from "../lib/gridSelection";

/**
 * The booking grid's cells — one per court per time slice (design-system.md, "Slot-state
 * component tokens" and Patterns → Booking grid).
 *
 * <p>
 * <b>Every cell is a `gridcell` placed EXPLICITLY</b> (`grid-row` / `grid-column`), so the board
 * can lay a now-line and its sticky backdrops over the same tracks without auto-placement
 * shuffling a cell out of its court. The row wrappers stay `display: contents` for the ARIA
 * structure (D3-B04): a reader hears row, column header and cell, on the one screen whose meaning
 * is carried by position.
 * </p>
 *
 * <p>
 * <b>A cell's name is its POSITION when a control is inside it, and the whole story when
 * nothing is.</b> One name per node: a cell and its button both carrying the sentence is the
 * sentence read twice.
 * </p>
 *
 * <p>
 * <b>The watermark is the "press me".</b> Only actionable cells carry the fingerprint (D5): a
 * free slot, the viewer's own future booking, and — for an admin — another member's. A cell that
 * will not respond has none, and its absence is itself the cue. It hides itself when a cell is
 * selected (`aria-selected` on the gridcell).
 * </p>
 *
 * <p>
 * <b>Selection is drawn INSIDE the cell</b> — `ring-inset` — and so is keyboard focus
 * (`-outline-offset-2`), so two selected neighbours never touch across the 4px/6px gaps (R2).
 * </p>
 */

/** What every cell needs to know, carried once rather than threaded per cell. */
export type BoardContext = {
  day: ScheduleDay;
  rules: ViewerRules;
  isAdmin: boolean;
  /** The shown day in words ("Thu 1 Oct") when it is not today; null on today's grid (R2 F1-5). */
  dayLabel: string | null;
  /** The first name of the member the desk is booking for (`?as=`), whose group hours the grid draws (R2 F1-3). */
  forName?: string | null;
  /** The sentence a locked cell answers with (D4 §2.9) — visible and spoken. */
  explain: (reason: GridReason, where: string) => void;
  /** A single tap on a free cell outside selection mode: book that one slice. */
  onBook: (court: ScheduleCourt, startsAtUtc: string) => void;
  /** A booking the viewer may act on — their own, or anybody's for an admin. */
  onOpenBooking: (slot: ScheduleSlot, court: ScheduleCourt) => void;
  onLiftHold: (blockId: string) => void | Promise<void>;
  selection: SelectionApi;
};

export type SlotCellProps = {
  ctx: BoardContext;
  court: ScheduleCourt;
  slot?: ScheduleSlot;
  /** "Court 1 at 06:00" — what this cell IS, since position is what assistive tech cannot see. */
  where: string;
  startsAtUtc: string;
  facts: CellFacts;
  at: GridCoord;
  /** The CSS grid row line this cell sits on. */
  line: number;
  /** True on the one cell that is the grid's tab stop (roving tabindex). */
  roving: boolean;
  /** Whether this cell is the booking's first — the one that carries its name and control. */
  isHead: boolean;
  /** Rows from this one to the end of the grid, this one included — a block never draws past it. */
  rowsLeft: number;
};

/** The surface every cell draws, whatever its state. `border-transparent` survives forced colours. */
const SURFACE = cn(
  "no-lift relative flex h-full w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent",
  "px-2 text-left text-xs font-semibold leading-tight",
);
const PRESSABLE = "transition-colors duration-fast ease-standard motion-reduce:transition-none focus-visible:-outline-offset-2";

/** The fill and ink per state — `components.slot` in `lib/tokens.ts`, nowhere else. */
const TONE = {
  available: "bg-slot-available-fill text-slot-available-ink hover:border-slot-available-ink/40",
  mine: "bg-slot-mine-fill text-slot-mine-ink hover:border-slot-mine-ink/40",
  minePast: "border-border bg-slot-mine-past-fill text-slot-mine-past-ink",
  booked: "bg-slot-booked-fill text-slot-booked-ink",
  bookedAction: "bg-slot-booked-fill text-slot-booked-ink hover:border-control",
  past: "justify-center text-slot-past-ink",
  hold: "bg-slot-hold-fill bg-stripes text-slot-hold-ink",
  closed: "justify-center border-dashed border-border text-slot-closed-ink hover:bg-bg-muted",
  restricted: "border-dashed border-warning-strong/60 bg-slot-restricted-fill text-slot-restricted-ink",
  idle: "justify-center border-dashed border-border bg-slot-idle-fill/40 text-slot-idle-ink",
} as const;

/** A booking still confirming wears its state's fill, with no hover — it answers nothing yet. */
const PENDING_TONE = {
  mine: "bg-slot-mine-fill text-slot-mine-ink",
  booked: "bg-slot-booked-fill text-slot-booked-ink",
  hold: "bg-slot-hold-fill bg-stripes text-slot-hold-ink",
} as const;

/**
 * Room for the checkbox, so it never lies on the label (the "□ok" the P4 walk found).
 *
 * <p>
 * In selection mode, and on a selected cell, the room is always there. Outside the mode a
 * pointer that can HOVER gets the hover checkbox — so on such a device the room is kept at rest
 * too, like a list's checkbox gutter: the label never jumps under a pointer sweeping the grid,
 * and entering the mode moves nothing. A touch screen has no hover checkbox (hover variants are
 * `hoverOnlyWhenSupported`) and keeps the column's full width for the label.
 * </p>
 */
const CHECK_ROOM = "pl-8";
const HOVER_CHECK_ROOM = "[@media(hover:hover)]:pl-8";

/** In selection mode a cell that cannot be chosen drops its fill, so the choosable ones stand out. */
const RECEDED = "border-dashed border-border bg-transparent bg-none";

/**
 * A booking is ONE block, however many rows it covers: its head cell's surface is drawn tall
 * enough to span them (rows are 3rem, gaps 0.25rem), so there is no seam, no restarting stripe
 * and one selected edge around the whole thing. The rows it covers keep their own `gridcell`s —
 * a reader and a keyboard still walk every row — but they draw nothing and let the pointer
 * through to the block.
 */
function Block({ rows, children }: { rows: number; children: ReactNode }) {
  const height = `calc(${rows} * 3rem + ${rows - 1} * 0.25rem)`;
  return <div data-block-rows={rows} className="absolute inset-x-0 top-0" style={{ height }}>{children}</div>;
}

const CELL_SCROLL_MARGIN = "calc(var(--app-bottom-bar-height, 0px) + var(--grid-bar-room, 0px) + 4px)";

function Cell(props: {
  label: string; at: GridCoord; line: number; roving: boolean;
  /** No control inside: the cell itself is the focus target. */
  selfFocus: boolean;
  selectKey?: string | null; selected?: boolean; selecting: boolean;
  /** Draws nothing of its own: a pointer goes through to the block above it. */
  passThrough?: boolean;
  children: ReactNode;
}) {
  const { label, at, line, roving, selfFocus, selectKey, selected, selecting, passThrough, children } = props;
  // F1.14 — kept clear of the tab bar and the floating selection bar when a key brings it in.
  const style: CSSProperties = { gridRow: line, gridColumn: at.col + 2, scrollMarginBottom: CELL_SCROLL_MARGIN };
  return (
    <div
      role="gridcell"
      aria-label={label}
      aria-selected={selecting && selectKey ? Boolean(selected) : undefined}
      tabIndex={selfFocus ? (roving ? 0 : -1) : undefined}
      data-row={at.row}
      data-col={at.col}
      data-select-key={selectKey ?? undefined}
      style={style}
      className={cn("relative h-12 min-w-0 rounded-md focus-visible:-outline-offset-2", passThrough && "pointer-events-none")}
    >
      {children}
    </div>
  );
}

/**
 * The selected edge: a 2px accent border drawn INSIDE the cell, so neighbours never touch (R2).
 *
 * <p>
 * A border on an overlay rather than a `ring-inset`: a ring is a box-shadow, and the house
 * affordance layer clears `box-shadow` on every `.no-lift` cell under hover and press — the
 * selection vanished the moment the pointer rested on the cell it had just ticked.
 * </p>
 */
function SelectedEdge() {
  return <span aria-hidden="true" data-selected-edge="" className="pointer-events-none absolute -inset-px rounded-md border-2 border-accent-strong" />;
}

/** The checkbox a choosable cell wears in selection mode — and, on a desktop, on hover. */
function CellCheck({ checked, hoverOnly }: { checked: boolean; hoverOnly: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-cell-check=""
      className={cn(
        "absolute left-0 top-0 flex size-8 items-start justify-start p-1.5",
        hoverOnly && "opacity-0 transition-opacity duration-fast group-hover:opacity-100 motion-reduce:transition-none",
      )}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border-2",
          checked ? "border-primary bg-primary text-primary-ink" : "border-control bg-bg-surface",
        )}
      >
        {checked ? <Check size={12} weight="bold" /> : null}
      </span>
    </span>
  );
}

export function SlotCell(props: SlotCellProps) {
  const { slot, isHead } = props;
  if (!slot) return <EmptyCell {...props} />;
  // Only the booking's first cell carries its name and control; the rest continue it, so a
  // 60-minute booking reads as one block rather than four things to ask about.
  if (!isHead) return <ContinuationCell {...props} slot={slot} />;
  if (isPendingBooking(slot.bookingId)) return <PendingCell {...props} slot={slot} />;
  if (slot.status === "adminblock") return <HoldCell {...props} slot={slot} />;
  if (isPartnerSlot(slot) && !props.facts.isPast && slot.bookingId) return <PartnerCell {...props} slot={slot} />;
  if (slot.isMine) return <MyCell {...props} slot={slot} />;
  return <OtherCell {...props} slot={slot} />;
}

/** How many rows, from this one, the booking covers — at least one, never past the grid. */
function spanOf(slot: ScheduleSlot, startsAtUtc: string, sliceMinutes: number, rowsLeft: number): number {
  const rows = Math.ceil((Date.parse(slot.endsAtUtc) - Date.parse(startsAtUtc)) / (sliceMinutes * 60_000));
  return Math.max(1, Math.min(rows, rowsLeft));
}

/** A pointer on a desktop pressed the hover checkbox rather than the cell. */
function pressedCheck(e: MouseEvent): boolean {
  const hover = typeof matchMedia === "function" && matchMedia("(hover: hover)").matches;
  return hover && Boolean((e.target as HTMLElement).closest?.("[data-cell-check]"));
}

/** The click the browser fires when a long press lifts must not also book the one slot. */
function consumeLongPress(e: MouseEvent<HTMLElement>): boolean {
  if (e.currentTarget.dataset.longPressed !== "true") return false;
  delete e.currentTarget.dataset.longPressed;
  return true;
}

/**
 * What a press on a choosable cell does: in selection mode it ticks; on a desktop's hover
 * checkbox it enters the mode holding this cell; otherwise it does the cell's own thing (book
 * the slot, open the booking). A long press has already entered the mode — its click is eaten.
 */
function pressFor(ctx: BoardContext, key: SelectionKey, at: GridCoord, act: () => void) {
  const { selection } = ctx;
  return (e: MouseEvent<HTMLButtonElement>) => {
    if (consumeLongPress(e)) return;
    if (selection.active) { selection.toggle(key, at); return; }
    if (pressedCheck(e)) { selection.enterWith(key, at); return; }
    act();
  };
}

/** The props every choosable button carries: its press, its long press, its pressed state. */
function choosable(ctx: BoardContext, key: SelectionKey, at: GridCoord, act: () => void) {
  const { selection } = ctx;
  const selected = selection.isSelected(key);
  return {
    selected,
    button: {
      "aria-pressed": selection.active ? selected : undefined,
      onClick: pressFor(ctx, key, at, act),
      onPointerDown: selection.active ? undefined : selection.armLongPress(key, at),
    },
    check: (
      <>
        {selection.active ? <CellCheck checked={selected} hoverOnly={false} /> : <CellCheck checked={false} hoverOnly />}
        {selected ? <SelectedEdge /> : null}
      </>
    ),
    inset: selection.active || selected ? CHECK_ROOM : HOVER_CHECK_ROOM,
  };
}

function EmptyCell(props: SlotCellProps) {
  const { ctx, court, where, facts } = props;
  const verdict = cellVerdict(ctx.rules, facts);
  const selecting = ctx.selection.active;
  const cell = { at: props.at, line: props.line, roving: props.roving, selecting };
  if (verdict.reason === "past_time") {
    return (
      <Cell label={pastCellLabel(where)} selfFocus {...cell}>
        <div aria-hidden="true" className={cn(SURFACE, TONE.past)}>{CELL_TEXT.past}</div>
      </Cell>
    );
  }
  if (verdict.reason !== null) {
    return <Cell label={where} selfFocus={false} {...cell}><UnavailableCell {...props} reason={verdict.reason} /></Cell>;
  }
  if (court.isActive === false) {
    return (
      <Cell label={idleCellLabel(where)} selfFocus {...cell}>
        <div aria-hidden="true" className={cn(SURFACE, TONE.idle)}>{CELL_TEXT.idle}</div>
      </Cell>
    );
  }
  return <AvailableCell {...props} />;
}

function AvailableCell(props: SlotCellProps) {
  const { ctx, court, where, startsAtUtc, at } = props;
  const key = selectionKey(court.id, startsAtUtc);
  const pick = choosable(ctx, key, at, () => ctx.onBook(court, startsAtUtc));
  return (
    <Cell label={where} selfFocus={false} selectKey={key} selected={pick.selected} at={at} line={props.line} roving={props.roving} selecting={ctx.selection.active}>
      <Interactable asChild surface="cell" watermark>
        <button
          type="button"
          tabIndex={props.roving ? 0 : -1}
          aria-label={bookCellLabel(where, court.slicePriceCredits)}
          {...pick.button}
          className={cn(SURFACE, PRESSABLE, TONE.available, "group flex-col items-start justify-center gap-0", pick.inset)}
        >
          {pick.check}
          <span>{CELL_TEXT.available}</span>
          <span className="hidden font-medium md:inline">{formatCredits(court.slicePriceCredits)}</span>
        </button>
      </Interactable>
    </Cell>
  );
}

/** A cell that exists, is not this viewer's to take, and says why when it is pressed. */
function UnavailableCell(props: SlotCellProps & { reason: GridReason }) {
  const { ctx, reason, where } = props;
  const quota = isQuota(reason);
  const closed = reason === "out_of_hours";
  // An ordinary, ENABLED button: pressing it is the whole point — it explains. `aria-disabled`
  // would tell assistive tech (and Playwright) it cannot be operated. No watermark: it does not
  // book, and a fingerprint on it would promise that it does.
  return (
    <button
      type="button"
      tabIndex={props.roving ? 0 : -1}
      onClick={() => ctx.explain(reason, where)}
      aria-label={unavailableLabel(reason, where, ctx)}
      className={cn(
        SURFACE, PRESSABLE, "justify-center text-center font-medium",
        closed ? TONE.closed : TONE.restricted,
        ctx.selection.active && RECEDED,
      )}
    >
      {/* R2 F1-6: the member's own cap wears a gauge and "Your limit" — a lock and "Full" said
          the court was taken, on a court that was free. */}
      {closed ? null : quota ? <Gauge size={14} weight="bold" aria-hidden="true" className="shrink-0" /> : <Info size={14} weight="bold" aria-hidden="true" className="shrink-0" />}
      <span className="min-w-0 truncate">{unavailableWord(reason, ctx)}</span>
    </button>
  );
}

/**
 * A club hold — a plan's occurrence or an admin's one-off block. Named by the plan (D3 §5.6),
 * never "Blocked", with "Club hold" under it so a member knows it is the club and not another
 * member. An admin lifts it with a 44px icon button inside the cell (D3-B11).
 */
function HoldCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, startsAtUtc } = props;
  const liftable = ctx.isAdmin && Boolean(slot.bookingId) && !facts.isPast;
  const rows = spanOf(slot, startsAtUtc, facts.sliceMinutes, props.rowsLeft);
  return (
    <Cell label={holdCellLabel(where, slot.blockLabel)} selfFocus={!liftable} at={props.at} line={props.line} roving={props.roving} selecting={ctx.selection.active}>
      <Block rows={rows}>
      <div className={cn(SURFACE, TONE.hold, "items-start py-1.5 pr-1", ctx.selection.active && RECEDED)}>
        <span aria-hidden="true" className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{slot.blockLabel ?? CELL_TEXT.hold}</span>
          {slot.blockLabel ? <span className="truncate font-medium">{CELL_TEXT.hold}</span> : null}
        </span>
        {liftable ? (
          <IconButton
            label={holdLiftLabel(where, slot.blockLabel)}
            size="icon-sm"
            tabIndex={props.roving ? 0 : -1}
            onClick={() => ctx.onLiftHold(slot.bookingId!)}
            className="shrink-0 text-slot-hold-ink hover:bg-bg-surface/70"
          >
            <LockOpen aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>
      </Block>
    </Cell>
  );
}

/**
 * A booking just made, drawn before the confirming read has given it its real id (P4 walk).
 *
 * <p>
 * <b>Not actionable, and says so.</b> Its id is the page's provisional one, so opening it would
 * send a cancel — or lift a hold — for a booking the server has never heard of. It is an
 * `aria-disabled` button rather than a bare div so the roving tab stop can still land on it and
 * a reader hears WHY it does nothing; it is `aria-busy`, carries no watermark (it does not
 * respond) and no selection key (it cannot be chosen). The read that lands a moment later
 * replaces it with the real, actionable cell.
 * </p>
 */
function PendingCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, startsAtUtc } = props;
  const rows = spanOf(slot, startsAtUtc, facts.sliceMinutes, props.rowsLeft);
  let tone: string = PENDING_TONE.booked;
  if (slot.status === "adminblock") tone = PENDING_TONE.hold;
  else if (slot.isMine) tone = PENDING_TONE.mine;
  return (
    <Cell label={where} selfFocus={false} at={props.at} line={props.line} roving={props.roving} selecting={ctx.selection.active}>
      <Block rows={rows}>
        <button
          type="button"
          tabIndex={props.roving ? 0 : -1}
          aria-disabled="true"
          aria-busy="true"
          aria-label={PENDING_CELL.label(where)}
          data-pending=""
          className={cn(SURFACE, tone, "cursor-progress items-start py-2", ctx.selection.active && RECEDED)}
        >
          <Spinner />
          <span className="min-w-0 truncate">{PENDING_CELL.word}</span>
        </button>
      </Block>
    </Cell>
  );
}

/**
 * A later row of a booking that started above it. The head's block already covers it, so this
 * cell draws nothing and lets the pointer through; it exists so a reader and the arrow keys
 * still find a cell here, named for what it is.
 */
function ContinuationCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where } = props;
  return (
    <Cell label={continuesLabel(where, slot.isMine)} selfFocus passThrough at={props.at} line={props.line} roving={props.roving} selecting={ctx.selection.active}>
      {null}
    </Cell>
  );
}

function MyCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, court, startsAtUtc } = props;
  const rows = spanOf(slot, startsAtUtc, facts.sliceMinutes, props.rowsLeft);
  const cell = { at: props.at, line: props.line, roving: props.roving, selecting: ctx.selection.active };
  if (facts.isPast || !slot.bookingId) {
    return (
      <Cell label={minePastCellLabel(where, slot.checkedIn)} selfFocus {...cell}>
        <Block rows={rows}>
          <div aria-hidden="true" className={cn(SURFACE, TONE.minePast, "items-start py-2")}>
            {slot.checkedIn ? CELL_TEXT.played : CELL_TEXT.minePast}
          </div>
        </Block>
      </Cell>
    );
  }
  const onCourt = slot.checkedIn === true;
  const key = bookedKey(slot.bookingId);
  const pick = choosable(ctx, key, props.at, () => ctx.onOpenBooking(slot, court));
  return (
    <Cell label={where} selfFocus={false} selectKey={key} selected={pick.selected} {...cell}>
      <Block rows={rows}>
      <Interactable asChild surface="cell" watermark>
        <button
          type="button"
          tabIndex={props.roving ? 0 : -1}
          aria-label={mineCellLabel(where, slot.checkedIn)}
          {...pick.button}
          className={cn(SURFACE, PRESSABLE, TONE.mine, "group items-start py-2", pick.inset)}
        >
          {pick.check}
          {onCourt ? (
            <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-success-strong motion-reduce:animate-none" />
          ) : null}
          <span className="min-w-0 truncate">{onCourt ? CELL_TEXT.onCourt : CELL_TEXT.mine}</span>
        </button>
      </Interactable>
      </Block>
    </Cell>
  );
}

/**
 * A game the viewer holds an accepted partner's seat on (review round 1, F1.12; contract §2).
 * Theirs to OPEN — the booking page, where their share and the players are — never to cancel or
 * to choose for a bulk cancel: the booking is the organiser's.
 */
function PartnerCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, startsAtUtc } = props;
  const rows = spanOf(slot, startsAtUtc, facts.sliceMinutes, props.rowsLeft);
  return (
    <Cell label={where} selfFocus={false} at={props.at} line={props.line} roving={props.roving} selecting={ctx.selection.active}>
      <Block rows={rows}>
        <Interactable asChild surface="cell" watermark>
          <Link
            to={`/bookings/${slot.bookingId}`}
            tabIndex={props.roving ? 0 : -1}
            aria-label={partnerCellLabel(where)}
            data-partner-cell=""
            className={cn(SURFACE, PRESSABLE, TONE.mine, "items-start py-2", ctx.selection.active && RECEDED)}
          >
            <OwnerFace slot={slot} fallback={PARTNER_CELL_WORD} />
          </Link>
        </Interactable>
      </Block>
    </Cell>
  );
}

/** Photo and first name only — the booking grid's invariant (CLAUDE.md). */
function OwnerFace({ slot, fallback = CELL_TEXT.reserved }: { slot: ScheduleSlot; fallback?: string }) {
  const name = slot.ownerFirstName ?? fallback;
  return (
    <span aria-hidden="true" className="flex min-w-0 items-center gap-1.5">
      <Avatar size={24} className="ring-2 ring-bg-surface">
        {slot.ownerPhotoUrl ? <AvatarImage src={slot.ownerPhotoUrl} alt="" /> : null}
        <AvatarFallback>{name.slice(0, 1).toLocaleUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}

function OtherCell(props: SlotCellProps & { slot: ScheduleSlot }) {
  const { ctx, slot, where, facts, court, startsAtUtc } = props;
  const rows = spanOf(slot, startsAtUtc, facts.sliceMinutes, props.rowsLeft);
  const cell = { at: props.at, line: props.line, roving: props.roving, selecting: ctx.selection.active };
  // §8: an admin can cancel anyone's booking on their behalf. A member sees a face and a name.
  if (ctx.isAdmin && slot.bookingId && !facts.isPast) {
    const key = bookedKey(slot.bookingId);
    const pick = choosable(ctx, key, props.at, () => ctx.onOpenBooking(slot, court));
    return (
      <Cell label={where} selfFocus={false} selectKey={key} selected={pick.selected} {...cell}>
        <Block rows={rows}>
          <Interactable asChild surface="cell" watermark>
            <button
              type="button"
              tabIndex={props.roving ? 0 : -1}
              aria-label={otherCellAdminLabel(slot.ownerFirstName, where)}
              {...pick.button}
              className={cn(SURFACE, PRESSABLE, TONE.bookedAction, "group items-start py-2", pick.inset)}
            >
              {pick.check}
              <OwnerFace slot={slot} />
            </button>
          </Interactable>
        </Block>
      </Cell>
    );
  }
  return (
    <Cell label={bookedByLabel(where, slot.ownerFirstName)} selfFocus {...cell}>
      <Block rows={rows}>
        <div className={cn(SURFACE, TONE.booked, "items-start py-2", ctx.selection.active && RECEDED)}>
          <OwnerFace slot={slot} />
        </div>
      </Block>
    </Cell>
  );
}

/** True when the reason is the member's own daily maximum rather than a fact about the slot. */
function isQuota(reason: GridReason): boolean {
  return reason === "per_day_slot_cap" || reason === "per_day_minute_cap";
}

/** The short word an unavailable cell wears — D4 §7.3's table. */
function unavailableWord(reason: GridReason, ctx: BoardContext): string {
  if (reason === "out_of_hours") return CELL_TEXT.closed;
  if (isQuota(reason)) return CELL_TEXT.limit;
  return restrictionLabel(reason, ctx.rules.allowedWindows ?? [], Boolean(ctx.forName));
}

/** The control's accessible name: where, then why it is not this viewer's. */
function unavailableLabel(reason: GridReason, where: string, ctx: BoardContext): string {
  if (reason === "out_of_hours") return closedCellLabel(where);
  if (isQuota(reason)) return quotaCellLabel(where, ctx.rules.maxSlotsPerDay ?? 0, ctx.dayLabel);
  return `${where} — ${unavailableWhy(reason, ctx.forName ?? null)}`;
}
