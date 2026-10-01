import type { LedgerRow } from "@/lib/api";
import { clubDayAndClock } from "@/lib/clubClock";
import { LEDGER_COPY, ledgerCategory, ledgerDoneBy } from "@/lib/ledgerCopy";
import { formatSignedCredits } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { X } from "@/components/ui/icons";
import { TextLink } from "@/components/ui/text-link";
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { useIsSmUp } from "@/components/ui/use-media-query";

/**
 * One ledger movement, whole — review round 1, F3.8. A table row is a summary cut to fit a
 * column; the question a volunteer brings to a row ("who did this, and what was it for?") needs
 * every field of it, including the ones a phone folds away.
 */
export function LedgerDetailSheet({ row, onClose }: { row: LedgerRow | null; onClose: () => void }) {
  const wide = useIsSmUp();
  return (
    <Sheet open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side={wide ? "right" : "bottom"} data-sheet="ledger-row">
        {row ? (
          <>
            <SheetHeader>
              <SheetTitle>{rowTitle(row)}</SheetTitle>
              <SheetDescription>{clubDayAndClock(row.at)}</SheetDescription>
            </SheetHeader>
            <SheetBody>
              <LedgerFacts row={row} />
            </SheetBody>
            <SheetFooter>
              <Button variant="outline" onClick={onClose}>{LEDGER_COPY.close}</Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function rowTitle(row: LedgerRow): string {
  return `${ledgerCategory(row)} · ${formatSignedCredits(row.signedAmountCredits)}`;
}

/**
 * The same movement as a panel BESIDE the club's book (R4 form factor, SPEC §3.9): where the page
 * has the room, opening a row fills this panel instead of covering the table with a sheet, so an
 * admin walks the rows with ↑/↓ and reads each one whole. A labelled region with its own heading
 * and a close ×; nothing here is modal, so focus stays on the row that was opened.
 */
export function LedgerDetailPanel({ row, onClose }: { row: LedgerRow | null; onClose: () => void }) {
  if (!row) {
    return (
      <div data-ledger-panel="empty" className="flex flex-col gap-1 rounded-xl border border-dashed border-border p-4 text-sm">
        <p className="font-semibold text-text-primary">{LEDGER_COPY.panelEmptyTitle}</p>
        <p className="text-text-secondary">{LEDGER_COPY.panelEmptyHint}</p>
      </div>
    );
  }
  return (
    <section
      aria-labelledby="ledger-panel-title"
      data-ledger-panel={row.id}
      className="flex flex-col gap-4 rounded-xl border border-border bg-bg-surface p-4 shadow-xs"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 id="ledger-panel-title" className="break-words text-base font-semibold text-text-primary">{rowTitle(row)}</h2>
          <p className="text-sm text-text-secondary">{clubDayAndClock(row.at)}</p>
        </div>
        <IconButton label={LEDGER_COPY.closePanel} size="icon-sm" onClick={onClose}>
          <X aria-hidden="true" />
        </IconButton>
      </div>
      <LedgerFacts row={row} />
    </section>
  );
}

/** Every field of one movement, including the ones a phone folds away. */
function LedgerFacts({ row }: { row: LedgerRow }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      <Fact term={LEDGER_COPY.amount}>{formatSignedCredits(row.signedAmountCredits)}</Fact>
      <Fact term={LEDGER_COPY.categoryHeader}>{ledgerCategory(row)}</Fact>
      <Fact term={LEDGER_COPY.actorHeader}>{ledgerDoneBy(row)}</Fact>
      <Fact term={LEDGER_COPY.fromTo}>{`${row.from} → ${row.to}`}</Fact>
      <Fact term={LEDGER_COPY.when}>{clubDayAndClock(row.at)}</Fact>
      {row.comment ? <Fact term={LEDGER_COPY.comment}>{row.comment}</Fact> : null}
      {row.relatedBookingId ? (
        <Fact term={LEDGER_COPY.booking}>
          {/* A link that looks like one (VIS F3-15: it read as plain text in the sheet). */}
          <TextLink variant="standalone" to={`/bookings/${row.relatedBookingId}`}>
            {LEDGER_COPY.openBooking}
          </TextLink>
        </Fact>
      ) : null}
    </dl>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{term}</dt>
      <dd className="min-w-0 break-words text-text-primary">{children}</dd>
    </>
  );
}
