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
};

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
  return cell?.querySelector<HTMLElement>("button") ?? cell ?? null;
}

export function useGridInteractions(args: Args) {
  const { gridRef, selection, rowCount, colCount, firstRow, initialRow } = args;
  const [roving, setRoving] = useState<GridCoord>({ row: initialRow, col: 0 });
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
    focusTarget(gridRef.current, next)?.focus();
  }, [gridRef]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const here = coordOf(e.target) ?? stop;
    const clamp = (row: number, col: number) => ({
      row: Math.min(rowCount - 1, Math.max(firstRow, row)),
      col: Math.min(colCount - 1, Math.max(0, col)),
    });
    const go = (next: GridCoord) => {
      e.preventDefault();
      if (e.shiftKey) extendTo(here, next);
      moveTo(next);
    };
    switch (e.key) {
      case "ArrowDown": return go(clamp(here.row + 1, here.col));
      case "ArrowUp": return go(clamp(here.row - 1, here.col));
      case "ArrowRight": return go(clamp(here.row, here.col + 1));
      case "ArrowLeft": return go(clamp(here.row, here.col - 1));
      case "Home": return go(clamp(here.row, 0));
      case "End": return go(clamp(here.row, colCount - 1));
      case "Escape":
        if (!selection.active) return undefined;
        e.preventDefault();
        return selection.count ? selection.clearAll() : selection.leave();
      default: return undefined;
    }
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
