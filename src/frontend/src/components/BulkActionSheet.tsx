import { Modal } from "./Modal";
import { BulkCancelSheet } from "./BulkCancelSheet";
import { BulkBookSheet, type BulkSlot } from "./BulkBookSheet";
import type { ScheduleDay, ScheduleSlot } from "../lib/api";
import { splitSelection, type SelectionKey } from "../lib/gridSelection";
import type { MemberOption } from "../pages/Schedule";
import { bookButtonLabel, cancelButtonLabel } from "../lib/bulkCopy";

/**
 * The one door into a bulk action — items 5 and 13.
 *
 * <p>
 * It resolves a set of selection KEYS back into the things they name, so neither sheet has to
 * know how a cell is identified, and it renders them inside the shared `Modal` rather than a
 * forked one: the focus trap, the initial focus and the no-discard-on-overlay-click that
 * `Modal` is being given right now (D3-B05 / D4 §2.3) land here for free the moment they land
 * at all. Forking the primitive to get them sooner would be the last lane in this repo to have
 * them.
 * </p>
 */
export function BulkActionSheet({ mode, day, keys, members, actorUserId, onClose, onSettled }: {
  mode: "book" | "cancel";
  day: ScheduleDay;
  keys: SelectionKey[];
  members: MemberOption[];
  actorUserId: string | null;
  onClose: () => void;
  onSettled: (doneKeys: SelectionKey[]) => void;
}) {
  const { free, booked } = splitSelection(keys);

  if (mode === "cancel") {
    const targets = booked
      .map((bookingId) => resolveBooking(day, bookingId))
      .filter((t): t is { bookingId: string; slot: ScheduleSlot; courtName: string } => t !== null);
    return (
      <Modal title={cancelButtonLabel(targets.length)} onClose={onClose}>
        <BulkCancelSheet day={day} targets={targets} onClose={onClose}
          onSettled={(ids) => onSettled(ids.map((id) => `booked:${id}`))} />
      </Modal>
    );
  }

  const slots = free
    .map(({ courtId, startsAtUtc }) => resolveFree(day, courtId, startsAtUtc))
    .filter((s): s is BulkSlot => s !== null);
  return (
    <Modal title={bookButtonLabel(slots.length)} onClose={onClose}>
      <BulkBookSheet day={day} slots={slots} members={members} actorUserId={actorUserId}
        onClose={onClose} onSettled={onSettled} />
    </Modal>
  );
}

function resolveBooking(day: ScheduleDay, bookingId: string) {
  const slot = day.slots.find((s) => s.bookingId === bookingId);
  if (!slot) return null;
  const court = day.courts.find((c) => c.id === slot.courtId);
  return { bookingId, slot, courtName: court?.name ?? "that court" };
}

function resolveFree(day: ScheduleDay, courtId: string, startsAtUtc: string): BulkSlot | null {
  const court = day.courts.find((c) => c.id === courtId);
  if (!court) return null;
  return { courtId, courtName: court.name, startsAtUtc, priceCredits: court.slicePriceCredits };
}
