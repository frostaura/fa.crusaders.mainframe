import { useEffect } from "react";
import type { BookSheetProps } from "../components/bookings/BookSheet";
import type { CancelSheetProps } from "../components/bookings/CancelSheet";

/**
 * Stand-ins for the two booking sheets, for the grid's tests (see `bookingsKit`). They record
 * the props the page rendered them with and draw a named dialog while open. This module imports
 * nothing that imports the page — a `vi.mock` factory that did would deadlock on itself.
 */

/** The props the page last rendered each sheet with. */
export const sheets: { book: BookSheetProps | null; cancel: CancelSheetProps | null } = { book: null, cancel: null };

/** Written from an effect: rendering must not reach outside itself (react-hooks/immutability). */
function record<K extends keyof typeof sheets>(which: K, props: (typeof sheets)[K]) {
  sheets[which] = props;
}

export function resetSheets() {
  sheets.book = null;
  sheets.cancel = null;
}

function FakeBookSheet(props: BookSheetProps) {
  useEffect(() => { record("book", props); });
  if (!props.open) return null;
  return (
    <div role="dialog" aria-label="Book sheet" data-slots={props.slots.length}>
      {props.slots.map((s) => <p key={s.courtId + s.startsAt}>{`${s.courtName} · ${s.startsAt} · ${s.sliceCount}`}</p>)}
    </div>
  );
}

function FakeCancelSheet(props: CancelSheetProps) {
  useEffect(() => { record("cancel", props); });
  if (!props.open) return null;
  return (
    <div role="dialog" aria-label="Cancel sheet">
      {props.bookings.map((b) => <p key={b.bookingId}>{`${b.courtName} · ${b.whenLabel}`}</p>)}
    </div>
  );
}

export const bookSheetModule = { BookSheet: FakeBookSheet };
export const cancelSheetModule = { CancelSheet: FakeCancelSheet };

