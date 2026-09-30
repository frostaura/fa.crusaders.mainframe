import { useCallback, useEffect, useRef, useState } from "react";
import { withinRectangle, type GridCoord, type SelectionApi, type SelectionKey } from "./gridSelection";

/**
 * The booking grid's keyboard and pointer model, out of the board component so the board stays
 * a layout and this stays testable in isolation.
 *
 * <ul>
 *   <li><b>One tab stop, always</b> (APG grid): the roving cell's control — or the cell itself
 *   when it holds none — is the only thing in the tab order; arrows move it. A grid of 240 tab
 *   stops is a grid a keyboard user cannot get past (D3 §4.7).</li>
 *   <li><b>Shift+Arrow and Shift+click grow a rectangle</b> from the anchor — the same shape a
 *   mouse drag paints (see `withinRectangle`). Either one enters selection mode.</li>
 *   <li><b>A mouse drag</b> across free cells is a marquee; the click the browser fires on
 *   release is swallowed so it cannot then book one slot. Touch never drags — a touch drag is a
 *   scroll; touch has the long press instead.</li>
 *   <li><b>Escape</b> drops the choices first and the mode second.</li>
 * </ul>
 *
 * <p>
 * Which cells a rectangle may take is read off the CELLS (`data-select-key`), never re-derived
 * from the day's rules — a marquee that took a Closed cell would charge somebody for it.
 * </p>
 */

type Args = {
  gridRef: React.RefObject<HTMLDivElement | null>;
  selection: SelectionApi;
  rowCount: number;
  colCount: number;
  /** Rows above this index are collapsed behind "Earlier today" and cannot take focus. */
  firstRow: number;
  /** Where the tab stop starts: the first row that has not started. */
  initialRow: number;
  /**
   * What the grid is showing — the day. A new one puts the tab stop back at `initialRow` (F1.17):
   * a stop carried over from another day left a keyboard starting at a past 06:00.
   */
  resetKey?: string;
};

/** How far PageUp / PageDown move: about a screenful of rows on a phone. */
const PAGE_ROWS = 8;

function coordOf(target: EventTarget | null): GridCoord | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-row][data-col]") as HTMLElement | null;
  if (!el) return null;
  const row = Number(el.dataset.row);
  const col = Number(el.dataset.col);
  return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
}

/** The element that takes focus for a cell: its control, else the cell. */
function focusTarget(grid: HTMLElement | null, at: GridCoord): HTMLElement | null {
  const cell = grid?.querySelector<HTMLElement>(`[role="gridcell"][data-row="${at.row}"][data-col="${at.col}"]`);
  return cell?.querySelector<HTMLElement>("button, a[href]") ?? cell ?? null;
}

/**
 * Focus without the browser's own jump, then bring the cell in NEAREST — which honours the
 * scroller's padding (the sticky court header, the time column) and the cell's bottom margin
 * (the tab bar, the selection bar), so a cell reached by keyboard is never under any of them
 * (F1.14).
 */
function focusInView(el: HTMLElement | null) {
  if (!el) return;
  el.focus({ preventScroll: true });
  // The CELL carries the margins (a control inside a booking block is taller than its row).
  const cell = el.closest<HTMLElement>('[role="gridcell"]') ?? el;
  if (typeof cell.scrollIntoView === "function") cell.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * The grid's one tab stop (R3 X-6): the roving cell's control, or the cell itself. Where focus
 * goes back to when a sheet closes and the control that opened it was re-rendered away — a Book
 * button that became the booking, a booking that became a free slot. It is the cell for that very
 * slot whenever the sheet was opened from a cell, because clicking a cell makes it the stop.
 */
export function gridTabStop(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="grid"] [tabindex="0"]');
}

type Move = (here: GridCoord, ctx: { rows: number; cols: number; first: number; ctrl: boolean }) => GridCoord;

/**
 * The APG grid keys, as a table rather than a switch (the complexity gate). Home/End stay in the
 * row; with Ctrl they go to the grid's first and last cell. PageUp/PageDown move a screenful.
 */
const MOVES: Record<string, Move> = {
  ArrowDown: (h) => ({ row: h.row + 1, col: h.col }),
  ArrowUp: (h) => ({ row: h.row - 1, col: h.col }),
  ArrowRight: (h) => ({ row: h.row, col: h.col + 1 }),
  ArrowLeft: (h) => ({ row: h.row, col: h.col - 1 }),
  PageDown: (h) => ({ row: h.row + PAGE_ROWS, col: h.col }),
  PageUp: (h) => ({ row: h.row - PAGE_ROWS, col: h.col }),
  Home: (h, c) => (c.ctrl ? { row: c.first, col: 0 } : { row: h.row, col: 0 }),
  End: (h, c) => (c.ctrl ? { row: c.rows - 1, col: c.cols - 1 } : { row: h.row, col: c.cols - 1 }),
};

export function useGridInteractions(args: Args) {
  const { gridRef, selection, rowCount, colCount, firstRow, initialRow, resetKey = "" } = args;
  const [held, setHeld] = useState<GridCoord & { key: string }>({ row: initialRow, col: 0, key: resetKey });
  // Derived, not synced: a stop from another day is not this day's stop.
  const roving: GridCoord = held.key === resetKey ? held : { row: initialRow, col: 0 };
  const setRoving = useCallback((at: GridCoord) => setHeld({ ...at, key: resetKey }), [resetKey]);
  // Clamped at read, so a collapse or a shorter day can never strand the only tab stop.
  const stop = {
    row: Math.min(Math.max(roving.row, firstRow), Math.max(firstRow, rowCount - 1)),
    col: Math.min(roving.col, Math.max(0, colCount - 1)),
  };

  const keysWithin = useCallback((a: GridCoord, b: GridCoord): SelectionKey[] => {
    const cells = gridRef.current?.querySelectorAll<HTMLElement>("[data-select-key]") ?? [];
    const out: SelectionKey[] = [];
    for (const el of cells) {
      const at = coordOf(el);
      if (at && withinRectangle(a, b, at)) out.push(el.dataset.selectKey!);
    }
    return out;
  }, [gridRef]);

  const extendTo = useCallback((from: GridCoord, to: GridCoord) => {
    if (!selection.anchor) selection.beginRange(from);
    selection.extendRange(keysWithin(selection.anchor ?? from, to));
  }, [selection, keysWithin]);

  const moveTo = useCallback((next: GridCoord) => {
    setRoving(next);
    focusInView(focusTarget(gridRef.current, next));
  }, [gridRef, setRoving]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (!selection.active) return undefined;
      e.preventDefault();
      return selection.count ? selection.clearAll() : selection.leave();
    }
    const move = MOVES[e.key];
    if (!move) return undefined;
    const here = coordOf(e.target) ?? stop;
    const to = move(here, { rows: rowCount, cols: colCount, first: firstRow, ctrl: e.ctrlKey || e.metaKey });
    const next = {
      row: Math.min(rowCount - 1, Math.max(firstRow, to.row)),
      col: Math.min(colCount - 1, Math.max(0, to.col)),
    };
    e.preventDefault();
    if (e.shiftKey) extendTo(here, next);
    moveTo(next);
    return undefined;
  };

  // Clicking or tabbing into a cell makes it the stop, so Tab back in lands where you were.
  const onFocus = (e: React.FocusEvent) => {
    const at = coordOf(e.target);
    if (at && (at.row !== roving.row || at.col !== roving.col)) setRoving(at);
  };

  /* ── the marquee: refs, not state — it redraws on every pointerover ── */
  const dragging = useRef<GridCoord | null>(null);
  const moved = useRef(false);
  const swallowClick = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || e.shiftKey) return;
    const at = coordOf(e.target);
    if (!at) return;
    dragging.current = at;
    moved.current = false;
  };

  const onPointerOver = (e: React.PointerEvent) => {
    const from = dragging.current;
    if (!from) return;
    const at = coordOf(e.target);
    if (!at || (at.row === from.row && at.col === from.col && !moved.current)) return;
    if (!moved.current) {
      moved.current = true;
      // The corner is fixed at the first crossing, keeping what is already chosen.
      selection.beginRange(from);
    }
    selection.extendRange(keysWithin(from, at));
  };

  useEffect(() => {
    const up = () => {
      if (dragging.current && moved.current) swallowClick.current = true;
      dragging.current = null;
      moved.current = false;
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  /** Shift+click extends; caught in the capture phase so the cell's own click never toggles it too. */
  const onClickCapture = (e: React.MouseEvent) => {
    if (swallowClick.current) {
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!e.shiftKey) return;
    const at = coordOf(e.target);
    if (!at) return;
    e.preventDefault();
    e.stopPropagation();
    extendTo(selection.active ? at : stop, at);
    setRoving(at);
  };

  return { stop, onKeyDown, onFocus, onPointerDown, onPointerOver, onClickCapture };
}
