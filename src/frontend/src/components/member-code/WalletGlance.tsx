import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Panel } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { TextLink } from "../ui/text-link";
import { useBalance, walletTone } from "../../lib/balance";
import { MY_CODE } from "../../lib/myCodeCopy";
import { TOP_UP_LABEL } from "../../lib/walletCopy";
import { typography } from "../../lib/typography";
import { cn, formatCredits } from "../../lib/utils";

/**
 * The wallet at a glance, beside the pass on a wide screen (R4 form factor, SPEC 3.2: "My Code +
 * today's bookings + wallet summary"). The SPENDABLE figure — what a booking can draw on — and
 * the way to top up, read from the balance the chip already holds (no read of its own).
 *
 * <p>
 * Three states, never collapsed: a skeleton while the first figure is on its way, nothing at all
 * when the balance could not be read (the chip in the bar says so, and the code is the point of
 * this page), the figure once it is known.
 * </p>
 */
export function WalletGlance() {
  const { balance, loading, held } = useBalance();
  if (balance === null) return loading ? <Skeleton className="h-28 rounded-xl" /> : null;
  const spendable = held?.spendable ?? balance;
  const level = walletTone(spendable);
  return (
    <Panel role="group" aria-label={MY_CODE.wallet.label} className="flex flex-col gap-3">
      <div className="min-w-0">
        <p className={typography({ variant: "overline" })}>{MY_CODE.wallet.spendable}</p>
        <p className={cn(typography({ variant: "display" }), "mt-1 text-3xl tabular-nums", level === "zero" && "text-danger-strong")}>
          {formatCredits(spendable)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button asChild variant={level === "zero" ? "primary" : "secondary"} size="sm">
          <Link to="/wallet/topup">{TOP_UP_LABEL[level]}</Link>
        </Button>
        <TextLink to="/wallet" variant="standalone">{MY_CODE.wallet.open}</TextLink>
      </div>
    </Panel>
  );
}
