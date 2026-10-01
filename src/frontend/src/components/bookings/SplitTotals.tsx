import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { SplitPreview } from "@/lib/playersApi";
import { BOOK_SHEET } from "@/lib/bookingsCopy";
import { BOOK_SPLIT, PLAYERS_COPY, PLAYERS_REFUSAL, playersRefusal } from "@/lib/playersCopy";
import { formatCredits } from "@/lib/utils";
import { seatName, type PlayersDraft } from "./playersDraft";
import { partnersTotal } from "./splitMath";
import type { SplitEditor } from "./usePlayersStep";

/**
 * The live totals bar: each seat's share as the SERVER splits it, and what that means for the
 * organiser — "You pay 100.00 cr now · you get 75.00 cr back as they accept". One block per
 * distinct slot price; a batch applies the split per booking, so it says "Each booking".
 *
 * <p>
 * A split the phone already knows cannot work is said at once, in the refusal's own sentence;
 * a split that is being worked out shows the rows as skeletons, never a figure it has not read.
 * </p>
 */

function nameOfSeat(draft: PlayersDraft, seat: number): string {
  if (seat === 1) return PLAYERS_COPY.you;
  const found = draft.seats.find((s) => s.seat === seat);
  return found ? seatName(found.player) : PLAYERS_COPY.openSeat;
}

function heading(preview: SplitPreview, count: number, bulk: boolean): string | null {
  if (count > 1) return BOOK_SPLIT.perPrice(formatCredits(preview.price_minutes));
  return bulk ? BOOK_SPLIT.eachBooking : null;
}

type TotalsBlockProps = { preview: SplitPreview; draft: PlayersDraft; title: string | null; hidePayNow: boolean };

function TotalsBlock({ preview, draft, title, hidePayNow }: TotalsBlockProps) {
  const back = partnersTotal(preview.shares);
  return (
    <div className="grid gap-2" data-totals={preview.price_minutes}>
      {title ? <p className="text-xs font-semibold uppercase tracking-overline text-text-muted">{title}</p> : null}
      <dl className="grid gap-1.5">
        {preview.shares.map((s) => (
          <div key={s.seat} className="flex items-baseline justify-between gap-4">
            <dt className="truncate text-text-secondary">{nameOfSeat(draft, s.seat)}</dt>
            <dd className="font-medium tabular-nums text-text-primary">{formatCredits(s.share_minutes)}</dd>
          </div>
        ))}
      </dl>
      {hidePayNow ? null : (
        <p className="border-t border-border pt-2 font-semibold text-text-primary">
          {BOOK_SPLIT.youPayNow(formatCredits(preview.price_minutes), formatCredits(back))}
        </p>
      )}
      <p className="text-xs text-text-secondary">{BOOK_SPLIT.addsUp(formatCredits(preview.price_minutes))}</p>
    </div>
  );
}

function TotalsSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-busy="true" className="grid gap-2">
      <span role="status" className="sr-only">{BOOK_SPLIT.reading}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex justify-between gap-4">
          <Skeleton className="h-4 w-20 rounded-sm" />
          <Skeleton className="h-4 w-16 rounded-sm" />
        </div>
      ))}
      <Skeleton className="mt-1 h-5 w-full rounded-sm" />
    </div>
  );
}

/**
 * <code>hidePayNow</code> (R2 F2-3): leave out the "You pay … now · you get … back" line. A booking
 * that already stands is paid for; its change-split sheet says what saving moves in a box of its
 * own, and the line read as a second charge. The BookSheet leaves it on.
 */
export function SplitTotals({ players, hidePayNow = false }: { players: SplitEditor; hidePayNow?: boolean }) {
  const state = players.preview.state;
  if (state.status === "invalid") {
    return <Alert tone="danger" live="polite">{PLAYERS_REFUSAL[state.error] ?? PLAYERS_REFUSAL.split_preview_invalid}</Alert>;
  }
  if (state.status === "error") {
    return (
      <div className="grid justify-items-start gap-3">
        <Alert tone="danger" className="w-full">{playersRefusal(state.error, { action: BOOK_SPLIT.previewAction })}</Alert>
        <Button variant="outline" onClick={players.preview.retry}>{BOOK_SHEET.retry}</Button>
      </div>
    );
  }
  return (
    <section aria-label={BOOK_SPLIT.totalsLabel} data-split-totals="" className="grid gap-4 rounded-xl bg-bg-muted p-4 text-sm">
      {state.status === "ready"
        ? state.previews.map((p) => (
          <TotalsBlock
            key={p.price_minutes} preview={p} draft={players.draft} hidePayNow={hidePayNow}
            title={heading(p, state.previews.length, players.bulk)}
          />
        ))
        : <TotalsSkeleton rows={players.draft.seats.length + 1} />}
    </section>
  );
}
