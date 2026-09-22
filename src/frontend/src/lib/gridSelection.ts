import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Multi-select on the booking grid — items 5 and 13.
 *
 * <p>
 * The state machine lives here rather than in the page for the reason `lib/scheduleEnd` does:
 * the schedule page already carries two modals, four mutations and an optimistic grid, and the
 * complexity gate is what stops that growing without anybody deciding to let it. It is also
 * the only way the selection rules get tested without rendering two hundred cells.
 * </p>
 *
 * <p>
 * <b>A selection is a set of KEYS, and the keys are stable identities</b> — a booking's id, or
 * a court-and-instant for a free slot. Not indices, and not DOM order: the grid repaints when
 * the clock crosses a slice boundary, and a selection addressed by position would silently
 * move under an admin who was reading it.
 * </p>
 *
 * <p>
 * <b>Changing the day clears the selection and says so.</b> A selection that survived a date
 * change would act on slots the admin is no longer looking at, which on a bulk cancel is other
 * people's money.
 * </p>
 */

export type SelectionTarget =
  | { kind: "free"; courtId: string; startsAtUtc: string }
  | { kind: "booked"; bookingId: string };

export type SelectionKey = string;

/** The one encoding, so a key made in a cell and a key read in the action bar are the same string. */
export function selectionKey(t: SelectionTarget): SelectionKey {
  return t.kind === "free" ? `free:${t.courtId}:${t.startsAtUtc}` : `booked:${t.bookingId}`;
}

/** The key back to what it names — the action bar has keys and needs court ids and booking ids. */
export function parseSelectionKey(key: SelectionKey): SelectionTarget | null {
  if (key.startsWith("booked:")) return { kind: "booked", bookingId: key.slice("booked:".length) };
  if (!key.startsWith("free:")) return null;
  const rest = key.slice("free:".length);
  const split = rest.indexOf(":");
  if (split <= 0) return null;
  return { kind: "free", courtId: rest.slice(0, split), startsAtUtc: rest.slice(split + 1) };
}

export type SelectionApi = {
  /** Whether the grid is IN selection mode. Cells behave normally when it is not. */
  active: boolean;
  count: number;
  isSelected(key: SelectionKey): boolean;
  toggle(key: SelectionKey, at?: GridCoord): void;
  /**
   * Long-press to enter selection mode and take this cell with you (D3 §4.1, door 2).
   *
   * <p>
   * 500 ms, and cancelled by any movement or release before then — a press that becomes a
   * scroll must not select anything, which on a phone grid is most presses.
   * </p>
   */
  armLongPress(key: SelectionKey, at?: GridCoord): (e: React.PointerEvent) => void;
  /**
   * Drop the choices but stay in the mode — the first Escape.
   *
   * <p>
   * Two steps rather than one, because an admin who has ticked twelve cells by mistake should
   * not also lose the mode they were working in. D3 §4.7.
   * </p>
   */
  clearAll(): void;
  /** Leave the mode — the second Escape, and the day strip's Done. */
  leave(): void;
  /**
   * The corner a Shift extension or a marquee measures from, or null when there is none.
   *
   * <p>
   * Set by an ordinary choice — a click, a Space, a long press, the start of a drag — so that
   * "extend from the last one I picked" means what an admin expects it to mean.
   * </p>
   */
  anchor: GridCoord | null;
  /**
   * Start a range at this cell: it becomes the anchor, and everything chosen so far is kept.
   *
   * <p>
   * The kept set is what makes an extension REPLACEABLE rather than merely additive. Dragging
   * out a rectangle and then dragging a smaller one from the same corner shrinks it, because
   * the second extension is applied to the set as it was before the first — which is the
   * behaviour of every grid anybody has used, and the reason a mis-drag is not a mistake you
   * have to undo cell by cell.
   * </p>
   */
  beginRange(at: GridCoord): void;
  /**
   * Replace the current extension with these keys, and turn the mode on.
   *
   * The caller supplies the keys because the geometry is the GRID's: which cells lie in the
   * rectangle, and which of those may be chosen at all, are questions this module would have
   * to answer with a second copy of the day's rules. See `candidateAs`.
   */
  extendRange(keys: readonly SelectionKey[]): void;
};

/** The key for this cell when it can be chosen right now, else null. */
export function selectableAs(
  selection: SelectionApi | null, target: SelectionTarget, allowed: boolean,
): SelectionKey | null {
  if (!selection?.active || !allowed) return null;
  return selectionKey(target);
}

/**
 * The key for this cell if it could EVER be chosen — whether or not the mode is on.
 *
 * <p>
 * The marquee needs this and `selectableAs` cannot give it: a drag is one of the three ways
 * INTO selection mode (D3 §4.1), so at the moment the pointer goes down no cell is selectable
 * yet. Written onto the cell as `data-select-key`, it is also what stops the range machinery
 * keeping a second copy of "which cells may be chosen" — the cell decides, once, and the
 * marquee and the Shift extension read the cell's own answer instead of re-deriving it from
 * the day's rules and drifting from it.
 * </p>
 */
export function candidateAs(
  selection: SelectionApi | null, target: SelectionTarget, allowed: boolean,
): SelectionKey | null {
  if (!selection || !allowed) return null;
  return selectionKey(target);
}

/** Where a cell is in the grid. Row is the time slice, column is the court. */
export type GridCoord = { row: number; col: number };

/**
 * Is `c` inside the rectangle the two corners span?
 *
 * <p>
 * <b>A rectangle, and D3 §4.1 says "reading order" for Shift+click.</b> This deviates, with a
 * reason: reading order is the right model for a LIST and the wrong one for a grid. An admin
 * shift-clicking from Court 2 at 18:00 to Court 2 at 20:00 means that court for those two
 * hours — which is the commonest thing anybody does on this screen, a league night on one
 * court. In reading order that same pair also takes courts 3 and 4 at 18:00, every court of
 * every row between, and courts 1 and 2 at 20:00: eighteen slots where two hours of one court
 * were asked for, on a control that ends in a bulk charge.
 * </p>
 *
 * <p>
 * It also makes the keyboard and the pointer agree. A drag paints the rectangle the pointer
 * sweeps because that is the shape a pointer draws; a Shift+Arrow that grew a different shape
 * from the same corners would be two selection models in one grid.
 * </p>
 */
export function withinRectangle(a: GridCoord, b: GridCoord, c: GridCoord): boolean {
  return c.row >= Math.min(a.row, b.row) && c.row <= Math.max(a.row, b.row)
    && c.col >= Math.min(a.col, b.col) && c.col <= Math.max(a.col, b.col);
}

/** The key for this cell when a long press on it would TURN selection mode on, else null. */
export function pressableAs(
  selection: SelectionApi | null, target: SelectionTarget, allowed: boolean,
): SelectionKey | null {
  if (!selection || selection.active || !allowed) return null;
  return selectionKey(target);
}

export const LONG_PRESS_MS = 500;

export type Selection = {
  api: SelectionApi;
  keys: SelectionKey[];
  enter(): void;
  /** Leave selection mode entirely. */
  exit(): void;
  /** What the day strip's one button does. In here so the page carries no branch for it. */
  toggleMode(): void;
  /** Keep the mode, drop the choices — what a date change does, and what Clear does. */
  clear(): void;
  /** Drop specific keys, for the cells a batch has just acted on. */
  drop(keys: readonly SelectionKey[]): void;
};

/**
 * Selection state for one grid.
 *
 * @param enabled false for a member — there is no selection mode at all on a member's grid,
 *   and `null` rather than a disabled API is what keeps the cells free of a role check.
 * @param onAnnounce a sentence for the polite live region the action bar owns.
 */
export function useGridSelection(enabled: boolean, onAnnounce: (text: string) => void): Selection | null {
  const [active, setActive] = useState(false);
  const [keys, setKeys] = useState<SelectionKey[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The corner an extension measures from, and the set to measure it against. */
  const [anchor, setAnchor] = useState<GridCoord | null>(null);
  const base = useRef<SelectionKey[]>([]);

  const toggle = useCallback((key: SelectionKey, at?: GridCoord) => {
    // An ordinary choice re-anchors. "Extend from the last one I picked" is only true if
    // picking one moves the corner.
    if (at) { setAnchor(at); }
    setKeys((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (at) base.current = next;
      return next;
    });
  }, []);

  const beginRange = useCallback((at: GridCoord) => {
    setAnchor(at);
    setKeys((prev) => { base.current = prev; return prev; });
  }, []);

  const extendRange = useCallback((range: readonly SelectionKey[]) => {
    setActive(true);
    setKeys(() => {
      const out = [...base.current];
      for (const k of range) if (!out.includes(k)) out.push(k);
      return out;
    });
  }, []);

  const armLongPress = useCallback((key: SelectionKey, at?: GridCoord) => (e: React.PointerEvent) => {
    // Coarse pointers only. On a mouse the marquee drag is the route in, and a 500 ms
    // hold-and-click on a desktop would fire on every slow click.
    if (e.pointerType === "mouse") return;
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      e.currentTarget.removeEventListener("pointerup", cancel);
      e.currentTarget.removeEventListener("pointercancel", cancel);
      e.currentTarget.removeEventListener("pointermove", cancel);
    };
    e.currentTarget.addEventListener("pointerup", cancel);
    e.currentTarget.addEventListener("pointercancel", cancel);
    e.currentTarget.addEventListener("pointermove", cancel);
    timer.current = setTimeout(() => {
      cancel();
      setActive(true);
      base.current = [key];
      if (at) setAnchor(at);
      setKeys([key]);
      onAnnounce("Selection on. Use the arrow keys to move and space to choose.");
    }, LONG_PRESS_MS);
  }, [onAnnounce]);

  const enter = useCallback(() => {
    setActive(true);
    onAnnounce("Selection on. Use the arrow keys to move and space to choose.");
  }, [onAnnounce]);
  const exit = useCallback(() => {
    setActive(false);
    base.current = [];
    setAnchor(null);
    setKeys([]);
    onAnnounce("Selection off.");
  }, [onAnnounce]);

  const api = useMemo<SelectionApi>(() => ({
    active, count: keys.length,
    isSelected: (key) => keys.includes(key),
    toggle, armLongPress,
    clearAll: () => { base.current = []; setAnchor(null); setKeys([]); },
    leave: exit,
    anchor, beginRange, extendRange,
  }), [active, keys, toggle, armLongPress, exit, anchor, beginRange, extendRange]);

  return useMemo<Selection | null>(() => {
    if (!enabled) return null;
    return {
      api, keys,
      enter,
      exit,
      toggleMode: () => (active ? exit() : enter()),
      clear: () => { base.current = []; setAnchor(null); setKeys([]); },
      drop: (done) => setKeys((prev) => {
        const next = prev.filter((k) => !done.includes(k));
        base.current = next;
        return next;
      }),
    };
  }, [enabled, api, keys, active, enter, exit]);
}

/** How a selection splits: free slots get booked, booked rows get cancelled. */
export function splitSelection(keys: readonly SelectionKey[]): {
  free: { courtId: string; startsAtUtc: string }[]; booked: string[];
} {
  const free: { courtId: string; startsAtUtc: string }[] = [];
  const booked: string[] = [];
  for (const key of keys) {
    const t = parseSelectionKey(key);
    if (t?.kind === "free") free.push({ courtId: t.courtId, startsAtUtc: t.startsAtUtc });
    else if (t?.kind === "booked") booked.push(t.bookingId);
  }
  return { free, booked };
}
