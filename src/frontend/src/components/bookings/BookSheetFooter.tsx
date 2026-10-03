import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { BUY_MINUTES_PATH } from "@/lib/minutes";
import { BOOK_PLAYERS } from "@/lib/playersCopy";
import type { BookFlow } from "./useBookFlow";
import { isAdminRun } from "./bookFlow";

/**
 * The Book sheet's footer: the way out and the primary on each step, the picker's Back, and the
 * result's Done — out of `BookSheet.tsx` so the complexity gate measures each function (lizard's
 * TSX lexer ran the sheet's last functions together).
 */

type FooterProps = { flow: BookFlow; onClose: () => void; reasonId: string; note: ReactNode };

export function BookFooter(props: FooterProps) {
  // Destructured in the body: lizard reads a destructured parameter list as the body's start and
  // hands this whole function to the one above it.
  const { flow, onClose, reasonId, note } = props;
  if (flow.run) return <ResultFooter flow={flow} onClose={onClose} note={note} />;
  if (flow.players.picking !== null) {
    // The picker is a panel inside the Players step: its way out is Back, to the seats.
    return (
      <DialogFooter>
        <Button variant="outline" onClick={flow.back}>{BOOK_PLAYERS.pickerBack}</Button>
      </DialogFooter>
    );
  }
  const first = flow.stepIndex === 0;
  const way = first ? BOOK_SHEET.cancel : BOOK_SHEET.back;
  return (
    <DialogFooter>
      {note}
      {/* R4 I4-1 — no way out while the booking is on its way; the note above says why. */}
      {flow.busy ? null : <Button variant="outline" onClick={first ? onClose : flow.back}>{way}</Button>}
      {flow.confirming ? <PrimaryButton flow={flow} reasonId={reasonId} onClose={onClose} /> : <Button onClick={flow.next}>{BOOK_SHEET.next}</Button>}
    </DialogFooter>
  );
}

type PrimaryProps = { flow: BookFlow; reasonId: string; onClose: () => void };

function PrimaryButton(props: PrimaryProps) {
  const { flow, reasonId, onClose } = props;
  const { primary } = flow;
  if (primary.kind === "none") return null;
  if (primary.kind === "gone") return <PickAnother label={primary.label} onClose={onClose} />;
  if (primary.kind === "unavailable") {
    // `aria-disabled`, never `disabled`: it stays focusable, so a reader reaches it and hears
    // why (its description) — and with no handler, a press does nothing.
    return (
      <Button aria-disabled="true" aria-describedby={reasonId} data-unavailable="" className="cursor-not-allowed opacity-50 hover:bg-primary">
        {primary.label}
      </Button>
    );
  }
  if (primary.kind === "reading") {
    return <Button pending data-reading="">{primary.label}</Button>;
  }
  // R4 I4-2 — ready the moment it appears: only a double tap's second half is ignored (its click
  // count says so), never a deliberate first tap.
  return (
    <Button pending={flow.busy} onClick={(e) => flow.submit(primary.allowNegativeBalance, e.detail)}>
      {primary.label}
    </Button>
  );
}

/**
 * R11 X11-3 — the slot is gone (the refusal above says so): Book again cannot work, so the primary
 * closes onto the refreshed grid, and the keyboard is put on it — never left on a Book button for
 * a slot that is somebody else's.
 */
function PickAnother(props: { label: string; onClose: () => void }) {
  const { label, onClose } = props;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <Button ref={ref} data-pick-another="" onClick={onClose}>{label}</Button>;
}

type ResultFooterProps = { flow: BookFlow; onClose: () => void; note: ReactNode };

function ResultFooter(props: ResultFooterProps) {
  const { flow, onClose, note } = props;
  const halted = flow.run?.halted === "insufficient_balance";
  const admin = isAdminRun(flow);
  return (
    <DialogFooter>
      {halted && !admin ? (
        <Button variant="outline" asChild>
          <Link to={BUY_MINUTES_PATH}>{BOOK_SHEET.buyMinutes}</Link>
        </Button>
      ) : null}
      {halted ? (
        <Button variant="outline" pending={flow.busy} onClick={(e) => flow.submit(admin, e.detail)}>
          {admin ? BOOK_SHEET.bookRestAnyway : BOOK_SHEET.retry}
        </Button>
      ) : null}
      {note}
      {flow.busy ? null : <Button onClick={onClose}>{BOOK_SHEET.done}</Button>}
    </DialogFooter>
  );
}
