import { useSyncExternalStore } from "react";

/**
 * Marks that outlive the inbox page. Tapping a notice that opens somewhere marks it read and, on
 * a phone, LEAVES the inbox — so the page's own optimistic state dies with the mark still on the
 * wire. Coming back draws `lib/offline`'s copy of the list, read before the tap (and reused as is
 * while under `JOIN_MS` old), which still says unread. Held here, at module scope, a mark is laid
 * over whatever list is drawn until a list says what the club holds (see {@link releaseMarks}).
 *
 * <p>
 * Keyed by notice id alone: ids are unique, so another member's list never matches one.
 * </p>
 */

/** Notice id → when its write settled (ms; null while it is out), and whether it is known to have landed. */
type Held = { settled: number | null; landed: boolean };
export type HeldMarks = ReadonlyMap<string, Held>;
const held = new Map<string, Held>();
const listeners = new Set<() => void>();
/** What renders read: a fresh copy per change, so a hook's memo sees the change. */
let view: HeldMarks = new Map();

function changed() {
  view = new Map(held);
  for (const fn of listeners) fn();
}

/** The mark is on its way: read, whatever list is drawn. */
export function holdMark(id: string): void {
  held.set(id, { settled: null, landed: false });
  changed();
}

/**
 * The write answered. LANDED, it is held until a list shows the notice read — a list answered
 * after this may still have been read before the mark reached the club, and the club never
 * un-reads a notice. Outcome unknown, it is held only over lists read before now.
 */
export function settleMark(id: string, landed: boolean): void {
  if (!held.has(id)) return;
  held.set(id, { settled: Date.now(), landed });
  changed();
}

/** The club refused it — nothing changed, so nothing is laid over the list. */
export function dropMark(id: string): void {
  if (held.delete(id)) changed();
}

/**
 * Whether a list read at `readAt` (ms; null when unknown) must show `id` as read regardless of what
 * it says: the mark is out or landed, or its outcome is unknown and it settled after that list was read.
 */
export function heldRead(marks: HeldMarks, id: string, readAt: number | null): boolean {
  const mark = marks.get(id);
  if (!mark) return false;
  if (mark.settled === null || mark.landed) return true;
  return readAt === null || readAt < mark.settled;
}

/**
 * Let go of the marks the newest page, read at `readAt`, already speaks for: the notice shows as
 * read; or the page was read after the mark settled and the outcome was unknown (the club's word
 * now) or the notice is no longer on it.
 */
export function releaseMarks(items: readonly { id: string; read_at: string | null }[], readAt: number | null): void {
  let any = false;
  for (const [id, mark] of held) {
    const notice = items.find((n) => n.id === id);
    const after = mark.settled !== null && readAt !== null && readAt >= mark.settled;
    if (notice?.read_at || (after && (!mark.landed || !notice))) { held.delete(id); any = true; }
  }
  if (any) changed();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const snapshot = () => view;

/** The held marks, re-rendering when one changes. */
export function useHeldMarks(): HeldMarks {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Tests only: no mark carried from one test to the next. */
export function resetHeldMarksForTests(): void {
  held.clear();
  changed();
}
