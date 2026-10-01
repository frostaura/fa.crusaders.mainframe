import { useCallback, useMemo, useRef, useState } from "react";
import type { ScheduleDay } from "./api";
import type { GridBooking, SelectedSlot } from "../components/bookings/types";
import { clubDayAndClock } from "./clubClock";
import type { PriceOf } from "./viewerPrice";

/**
 * Multi-select on the booking grid — R4, and D8: members get it too.
 *
 * <p>
 * <b>Only a cell the viewer could act on is ever selectable</b> (design-system.md's slot-state
 * table): a free slot they could book, their own future booking, and — for an admin — anybody's
 * future booking. The cell decides that (`cellVerdict` — past, taken, closed, group window,
 * peak, quota) and publishes the answer as `data-select-key`; this module never re-derives it.
 * What the grid cannot pre-filter — balance, a race with another member — the server refuses
 * per item, and the sheet shows it.
 * </p>
 *
 * <p>
 * <b>A selection is a set of KEYS, and the keys are stable identities</b> — a court and an
 * instant. Not indices and not DOM order: the grid repaints when the clock crosses a slice, and
 * a selection addressed by position would move under a member who was reading it.
 * </p>
 *
 * <p>
 * <b>The member's daily cap is honoured here</b> (`cap`, the server's `remainingToday`). A
 * member four slots from their limit cannot tick a fifth; they are told why, once, in the live
 * region. An admin has no cap (`null`).
 * </p>
 */

export type SelectionKey = string;

/** Where a cell is in the grid. Row is the time slice, column is the court. */
export type GridCoord = { row: number; col: number };

export type SelectionTarget =
  | { kind: "free"; courtId: string; startsAtUtc: string }
  | { kind: "booked"; bookingId: string };

/** The key for a free slice. One encoding, so a cell's key and the page's reading agree. */
export function selectionKey(courtId: string, startsAtUtc: string): SelectionKey {
  return `free:${courtId}:${startsAtUtc}`;
}

/** The key for a booking — its id, which is stable however many rows it spans. */
export function bookedKey(bookingId: string): SelectionKey {
  return `booked:${bookingId}`;
}

/**
 * The provisional id a just-made booking wears until the confirming read replaces it.
 *
 * <p>
 * One spelling, written and recognised here, because the grid must be able to tell such a cell
 * apart: it is not actionable, and it is never selectable. A cancel sent for this id is a cancel
 * for a booking the server has never heard of.
 * </p>
 */
const PENDING_PREFIX = "pending:";

export function pendingBookingId(courtId: string, startsAtUtc: string): string {
  return `${PENDING_PREFIX}${courtId}:${startsAtUtc}`;
}

export function isPendingBooking(bookingId: string | null | undefined): boolean {
  return typeof bookingId === "string" && bookingId.startsWith(PENDING_PREFIX);
}

/** The key back to what it names, or null for anything this module did not write. */
export function parseSelectionKey(key: SelectionKey): SelectionTarget | null {
  if (key.startsWith("booked:")) return { kind: "booked", bookingId: key.slice("booked:".length) };
  if (!key.startsWith("free:")) return null;
  const rest = key.slice("free:".length);
  const split = rest.indexOf(":");
  if (split <= 0) return null;
  return { kind: "free", courtId: rest.slice(0, split), startsAtUtc: rest.slice(split + 1) };
}

/** How many of these keys are free slices — the only kind the member's daily cap counts. */
export function freeCount(keys: readonly SelectionKey[]): number {
  return keys.filter((k) => k.startsWith("free:")).length;
}

/**
 * Is `c` inside the rectangle the two corners span?
 *
 * <p>
 * A rectangle, not a reading-order run: Shift+click from Court 2 at 18:00 to Court 2 at 20:00
 * means that court for those two hours — the commonest thing anybody does here — where reading
 * order would also sweep every court of every row between. It also makes the keyboard and the
 * pointer agree: Shift+Arrow grows the same shape a drag paints.
 * </p>
 */
export function withinRectangle(a: GridCoord, b: GridCoord, c: GridCoord): boolean {
  return c.row >= Math.min(a.row, b.row) && c.row <= Math.max(a.row, b.row)
    && c.col >= Math.min(a.col, b.col) && c.col <= Math.max(a.col, b.col);
}

/** How long a touch must rest on a free cell before it becomes a selection (design-system.md). */
export const LONG_PRESS_MS = 450;

export type SelectionApi = {
  /** Whether the grid is IN selection mode. A tap books one slot when it is not. */
  active: boolean;
  count: number;
  isSelected(key: SelectionKey): boolean;
  /** Tick or untick one cell, re-anchoring there. Refused (and said) at the member's cap. */
  toggle(key: SelectionKey, at?: GridCoord): void;
  /** Enter the mode holding this one cell — the hover checkbox and the long press. */
  enterWith(key: SelectionKey, at?: GridCoord): void;
  /** A touch resting on a free cell (coarse pointers only; a mouse drags instead). */
  armLongPress(key: SelectionKey, at?: GridCoord): (e: React.PointerEvent) => void;
  /** Drop the choices, keep the mode — the first Escape. */
  clearAll(): void;
  /** Leave the mode — the second Escape, the × on the bar, the toolbar toggle. */
  leave(): void;
  /** The corner a Shift extension or a drag measures from. */
  anchor: GridCoord | null;
  /** Start a range here, keeping what is already chosen so the range can be pulled back. */
  beginRange(at: GridCoord): void;
  /** Replace the current extension with these keys (cells in the rectangle that may be chosen). */
  extendRange(keys: readonly SelectionKey[]): void;
};

export type Selection = {
  api: SelectionApi;
  keys: SelectionKey[];
  /** The toolbar toggle. */
  toggleMode(): void;
  /** Keep the mode, drop the choices — a date change, and a finished booking. */
  clear(): void;
  /**
   * R4 M4-7 — why the last pick was refused (the member's daily cap), until the next change. It
   * was said only to a screen reader; a sighted member's fifth tap did nothing at all.
   */
  refusal: string | null;
};

type Options = {
  /** At most this many may be chosen (the member's remaining slots today); `null` = no limit. */
  cap: number | null;
  /** A sentence for the page's polite live region. */
  announce: (text: string) => void;
  /** What to say when the cap refuses a choice. */
  capSentence: (cap: number) => string;
  /** The same, short, for the selection bar (`refusal`); the full sentence when absent. */
  capShort?: (cap: number) => string;
  onSentence: string;
  offSentence: string;
};

/** Keep at most `cap` FREE keys, oldest first — the ones already chosen win over a new sweep. */
function capped(keys: SelectionKey[], cap: number | null): SelectionKey[] {
  if (cap === null) return keys;
  const out: SelectionKey[] = [];
  let free = 0;
  for (const k of keys) {
    const isFree = k.startsWith("free:");
    if (isFree && free >= cap) continue;
    if (isFree) free += 1;
    out.push(k);
  }
  return out;
}

/** A slightly longer vibration than a tap, where the platform has one. Never required. */
function hapticTick() {
  try { navigator.vibrate?.(10); } catch { /* a platform without haptics is not an error */ }
}

export function useGridSelection(options: Options): Selection {
  const { cap, announce, capSentence, capShort, onSentence, offSentence } = options;
  const [active, setActive] = useState(false);
  const [keys, setKeys] = useState<SelectionKey[]>([]);
  const [anchor, setAnchor] = useState<GridCoord | null>(null);
  /** The set an extension is measured against, so a second drag from one corner REPLACES the first. */
  const base = useRef<SelectionKey[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [refusal, setRefusal] = useState<string | null>(null);
  const refuse = useCallback(() => {
    announce(capSentence(cap ?? 0));
    setRefusal((capShort ?? capSentence)(cap ?? 0));
  }, [announce, capSentence, capShort, cap]);

  const toggle = useCallback((key: SelectionKey, at?: GridCoord) => {
    if (at) setAnchor(at);
    if (keys.includes(key)) {
      const next = keys.filter((k) => k !== key);
      base.current = next;
      setKeys(next);
      setRefusal(null);
      return;
    }
    if (cap !== null && key.startsWith("free:") && freeCount(keys) >= cap) { refuse(); return; }
    setRefusal(null);
    const next = [...keys, key];
    base.current = next;
    setKeys(next);
  }, [keys, cap, refuse]);

  const enterWith = useCallback((key: SelectionKey, at?: GridCoord) => {
    setActive(true);
    announce(onSentence);
    if (cap !== null && cap <= 0 && key.startsWith("free:")) { refuse(); return; }
    setRefusal(null);
    base.current = [key];
    if (at) setAnchor(at);
    setKeys([key]);
  }, [announce, onSentence, refuse, cap]);

  const beginRange = useCallback((at: GridCoord) => {
    setAnchor(at);
    base.current = keys;
  }, [keys]);

  const extendRange = useCallback((range: readonly SelectionKey[]) => {
    setActive(true);
    const out = [...base.current];
    for (const k of range) if (!out.includes(k)) out.push(k);
    const kept = capped(out, cap);
    if (kept.length < out.length) refuse();
    else setRefusal(null);
    setKeys(kept);
  }, [cap, refuse]);

  const armLongPress = useCallback((key: SelectionKey, at?: GridCoord) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const target = e.currentTarget as HTMLElement;
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      target.removeEventListener("pointerup", cancel);
      target.removeEventListener("pointercancel", cancel);
      target.removeEventListener("pointermove", onMove);
    };
    // A finger always drifts a pixel or two; only a real move (a scroll) cancels.
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (m: Event) => {
      const p = m as PointerEvent;
      if (Math.abs(p.clientX - startX) > 8 || Math.abs(p.clientY - startY) > 8) cancel();
    };
    target.addEventListener("pointerup", cancel);
    target.addEventListener("pointercancel", cancel);
    target.addEventListener("pointermove", onMove);
    timer.current = setTimeout(() => {
      cancel();
      hapticTick();
      // The click the browser fires on release must not then book the one slot.
      target.dataset.longPressed = "true";
      enterWith(key, at);
    }, LONG_PRESS_MS);
  }, [enterWith]);

  const clearAll = useCallback(() => { base.current = []; setAnchor(null); setKeys([]); setRefusal(null); }, []);
  const leave = useCallback(() => {
    setRefusal(null);
    base.current = [];
    setAnchor(null);
    setKeys([]);
    setActive(false);
    announce(offSentence);
  }, [announce, offSentence]);

  const api = useMemo<SelectionApi>(() => ({
    active, count: keys.length,
    isSelected: (key) => keys.includes(key),
    toggle, enterWith, armLongPress, clearAll, leave, anchor, beginRange, extendRange,
  }), [active, keys, toggle, enterWith, armLongPress, clearAll, leave, anchor, beginRange, extendRange]);

  return useMemo<Selection>(() => ({
    api, keys,
    toggleMode: () => {
      if (active) { leave(); return; }
      setActive(true);
      announce(onSentence);
    },
    clear: clearAll,
    refusal,
  }), [api, keys, active, leave, announce, onSentence, clearAll, refusal]);
}

/**
 * The selection as the BookSheet takes it: one item per run of adjacent slices on one court.
 *
 * <p>
 * A member who ticks 18:00, 18:15, 18:30 and 18:45 on Court 2 wants one hour on Court 2 — one
 * booking, one line on the receipt, one code — not four fifteen-minute bookings. A gap breaks
 * the run, and so does a court change. Items come back court by court in grid order, then by
 * time, so the sheet lists them the way the grid shows them.
 * </p>
 *
 * <p>
 * Priced at the VIEWER's price (`priceOf`, R5 I5-1) — their group's, not the court's own.
 * </p>
 */
export function toSelectedSlots(
  keys: readonly SelectionKey[], day: ScheduleDay | null, priceOf: PriceOf = (court) => court.slicePriceCredits,
): SelectedSlot[] {
  if (!day) return [];
  const sliceMs = (day.sliceMinutes > 0 ? day.sliceMinutes : 15) * 60_000;
  const out: SelectedSlot[] = [];
  for (const court of day.courts) {
    const starts = keys
      .map(parseSelectionKey)
      .filter((k): k is Extract<SelectionTarget, { kind: "free" }> => k?.kind === "free" && k.courtId === court.id)
      .map((k) => Date.parse(k.startsAtUtc))
      .filter((ms) => Number.isFinite(ms))
      .sort((a, b) => a - b);
    let run: { from: number; count: number } | null = null;
    const flush = () => {
      if (!run) return;
      out.push({
        courtId: court.id, courtName: court.name, startsAt: new Date(run.from).toISOString(),
        sliceCount: run.count, priceMinutes: priceOf(court) * run.count,
      });
    };
    for (const ms of starts) {
      if (run && ms === run.from + run.count * sliceMs) { run.count += 1; continue; }
      flush();
      run = { from: ms, count: 1 };
    }
    flush();
  }
  return out;
}

/** The bookings in a selection, as the CancelSheet takes them — resolved against the day shown. */
export function toGridBookings(keys: readonly SelectionKey[], day: ScheduleDay | null): GridBooking[] {
  if (!day) return [];
  const out: GridBooking[] = [];
  for (const key of keys) {
    const target = parseSelectionKey(key);
    if (target?.kind !== "booked") continue;
    const slot = day.slots.find((s) => s.bookingId === target.bookingId);
    if (slot) out.push(gridBookingOf(slot, day));
  }
  return out;
}

/** One booking the grid shows, as the sheets take it. Photo and first name only. */
export function gridBookingOf(slot: ScheduleDay["slots"][number], day: ScheduleDay): GridBooking {
  const court = day.courts.find((c) => c.id === slot.courtId);
  return {
    bookingId: slot.bookingId ?? "",
    courtId: slot.courtId,
    courtName: court?.name ?? "that court",
    startsAt: slot.startsAtUtc,
    endsAt: slot.endsAtUtc,
    whenLabel: clubDayAndClock(slot.startsAtUtc, day.timezone),
    mine: slot.isMine,
    memberFirstName: slot.isMine ? null : slot.ownerFirstName,
    memberPhotoUrl: slot.isMine ? null : slot.ownerPhotoUrl,
    checkedIn: slot.checkedIn,
    amountChargedMinutes: slot.amountChargedMinutes,
    timezone: day.timezone,
  };
}
