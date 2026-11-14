import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * The check step's footer, ONE layout for every desk money sheet (BA-20): Adjust minutes, Sell
 * package and Refund or chargeback.
 *
 * <p>
 * <b>Why one component.</b> The adjust sheet's footer switched to a column on the check step while
 * the sale's stayed a row, so one click on "Add 15 minutes" re-laid the footer under the pointer —
 * Back / sentence / Cancel + Add — and the pointer was left on the Cancel/Add boundary. Money flows
 * that move differently under the same hand teach the wrong muscle memory. Here Back sits on its own
 * line and the armed confirm has the full row beneath it, on every width, so arming changes only
 * what is inside the confirm's own box and nothing the pointer is near moves.
 * </p>
 */
export const DESK_FOOTER_CLASS = "sm:flex-col sm:items-stretch";

export function DeskConfirmFooter({ backLabel, onBack, busy, children }: {
  backLabel: string;
  onBack: () => void;
  /** While the press is on its way, Back would drop the receipt it lands on (R5 I5-3). */
  busy: boolean;
  /** The ConfirmButton. */
  children: ReactNode;
}) {
  return (
    <div data-desk-confirm="" className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex">
        <Button variant="outline" disabled={busy} onClick={onBack}>{backLabel}</Button>
      </div>
      <div data-desk-confirm-press="" className="min-w-0">{children}</div>
    </div>
  );
}
