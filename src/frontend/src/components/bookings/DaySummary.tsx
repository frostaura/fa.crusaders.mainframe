import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Panel } from "../ui/card";
import { useBalance, walletTone } from "../../lib/balance";
import { BOOKINGS_COPY } from "../../lib/bookingsCopy";
import { TOP_UP_LABEL } from "../../lib/walletCopy";
import { typography } from "../../lib/typography";
import { cn, formatCredits } from "../../lib/utils";

/**
 * What the member can spend, at the top of the Bookings rail (R4 form factor, SPEC 3.1), with the
 * way to top up — the figure every booking draws on, beside the grid it is spent on. The day's
 * quota and the member's rate stay beside the week strip, at every width: one place each, never
 * two (a copy hidden by CSS is still a second copy to a test and to a stale reader).
 *
 * <p>
 * Nothing until the balance is known: the chip in the bar carries loading and failure.
 * </p>
 */
export function DaySummary({ className }: { className?: string }) {
  const { balance, held } = useBalance();
  if (balance === null) return null;
  const spendable = held?.spendable ?? balance;
  const level = walletTone(spendable);
  return (
    <Panel role="group" aria-label={BOOKINGS_COPY.summaryTitle} className={cn("flex flex-col gap-3", className)}>
      <div>
        <p className={typography({ variant: "overline" })}>{BOOKINGS_COPY.summarySpendable}</p>
        <p className={cn("mt-1 font-display text-2xl font-bold tabular-nums", level === "zero" && "text-danger-strong")}>{formatCredits(spendable)}</p>
      </div>
      <Button asChild variant={level === "zero" ? "primary" : "secondary"} size="sm" className="self-start">
        <Link to="/wallet/topup">{TOP_UP_LABEL[level]}</Link>
      </Button>
    </Panel>
  );
}
