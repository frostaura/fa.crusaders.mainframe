import type { HeldFigures } from "@/lib/liveBalance";
import { HELD_EXPLAINER, OWED_BACK_EXPLAINER, heldLine, owedBackLine } from "@/lib/playersCopy";
import { heldPartsLine, spendableLine } from "@/lib/walletCopy";

/**
 * D11 §3a — the part of the balance a member cannot spend yet, said where the balance is.
 *
 * <p>
 * Shares partners paid an organiser are held until 48 hours after each game in case one comes
 * back. The card's big figure is the whole balance, so without this line a member with 2 h on
 * the card is refused a 1 h 50 min booking and cannot see why. Nothing at all when nothing is
 * held — a "0 min held" line on every wallet would be noise about a feature most members never use.
 * </p>
 *
 * <p>
 * <b>P11 — owed back.</b> A partner's return the organiser's balance could not cover waits on
 * that balance, and incoming minutes pay it first. It has no date, so it is its own line; and
 * because it can push spendable below zero, the spendable sentence never shows a negative.
 * </p>
 */
export function HeldLine({ held }: { held: HeldFigures | null }) {
  if (!held || (held.held <= 0 && held.owedBack <= 0)) return null;
  // F4-18 — two or more share deadlines: the total without a date, then each part with its own.
  const parts = heldPartsLine(held.parts);
  return (
    <div data-held-line="" className="mt-3 flex max-w-prose flex-col gap-1 border-t border-border pt-3 text-sm">
      <p className="font-semibold tabular-nums text-text-primary">
        {held.held > 0 ? <>{heldLine(held.held, parts ? null : held.until)}<span className="text-text-secondary"> · </span></> : null}
        <span className="text-text-primary">{spendableLine(held.spendable)}</span>
      </p>
      {parts ? <p data-held-parts="" className="tabular-nums text-text-primary">{parts}</p> : null}
      {held.held > 0 ? <p className="text-text-secondary">{HELD_EXPLAINER}</p> : null}
      {held.owedBack > 0 ? (
        <>
          <p data-owed-back-line="" className="font-semibold tabular-nums text-text-primary">{owedBackLine(held.owedBack)}</p>
          <p className="text-text-secondary">{OWED_BACK_EXPLAINER}</p>
        </>
      ) : null}
    </div>
  );
}
