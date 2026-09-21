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
  toggle(key: SelectionKey): void;
  /**
   * Long-press to enter selection mode and take this cell with you (D3 §4.1, door 2).
   *
   * <p>
   * 500 ms, and cancelled by any movement or release before then — a press that becomes a
   * scroll must not select anything, which on a phone grid is most presses.
   * </p>
   */
  armLongPress(key: SelectionKey): (e: React.PointerEvent) => void;
};

/** The key for this cell when it can be chosen right now, else null. */
export function selectableAs(
  selection: SelectionApi | null, target: SelectionTarget, allowed: boolean,
): SelectionKey | null {
  if (!selection?.active || !allowed) return null;
  return selectionKey(target);
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

  const toggle = useCallback((key: SelectionKey) => {
    setKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const armLongPress = useCallback((key: SelectionKey) => (e: React.PointerEvent) => {
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
      setKeys([key]);
      onAnnounce("Selection on. Use the arrow keys to move and space to choose.");
    }, LONG_PRESS_MS);
  }, [onAnnounce]);

  const api = useMemo<SelectionApi>(() => ({
    active, count: keys.length,
    isSelected: (key) => keys.includes(key),
    toggle, armLongPress,
  }), [active, keys, toggle, armLongPress]);

  return useMemo<Selection | null>(() => {
    if (!enabled) return null;
    return {
      api, keys,
      enter: () => { setActive(true); onAnnounce("Selection on. Use the arrow keys to move and space to choose."); },
      exit: () => { setActive(false); setKeys([]); onAnnounce("Selection off."); },
      clear: () => setKeys([]),
      drop: (done) => setKeys((prev) => prev.filter((k) => !done.includes(k))),
    };
  }, [enabled, api, keys, onAnnounce]);
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
