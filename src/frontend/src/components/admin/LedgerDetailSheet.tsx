import type { LedgerRow } from "@/lib/api";
import { clubDayAndClock } from "@/lib/clubClock";
import { LEDGER_COPY, ledgerCategory, ledgerDoneBy } from "@/lib/ledgerCopy";
import { formatSignedCredits } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
              <SheetTitle>{`${ledgerCategory(row)} · ${formatSignedCredits(row.signedAmountCredits)}`}</SheetTitle>
              <SheetDescription>{clubDayAndClock(row.at)}</SheetDescription>
            </SheetHeader>
            <SheetBody>
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

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-muted">{term}</dt>
      <dd className="min-w-0 break-words text-text-primary">{children}</dd>
    </>
  );
}
