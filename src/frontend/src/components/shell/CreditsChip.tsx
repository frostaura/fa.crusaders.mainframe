import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import { Wallet } from "@/components/ui/icons";
import { useBalance, walletHref, walletLabel, walletTone } from "@/lib/balance";
import { useCountUp, usePrefersReducedMotion } from "@/lib/useCountUp";
import { useZeroBalanceEntice } from "@/lib/zeroBalanceEntice";
import { cn, formatCredits } from "@/lib/utils";
import { chipHeldTitle } from "@/lib/walletCopy";
import { useToast } from "../Toast";

/**
 * The credits chip in the top bar (item 8, rebuilt on the P1 tokens for the P2 shell).
 *
 * <p>
 * Everything the old `CreditsBadge` promised, kept: the figure counts to a new balance; three
 * states with three looks (empty is not "running low"); a finite breathe at zero, or a static
 * "· Top up" word under reduced motion; exactly ONE toast when the club moves a member's money
 * (a changed `aria-label` is not an announcement, so without it a blind member is never told
 * they were paid) and none for their own spending; the accessible name carries the NUMBER and
 * the degraded-stream qualifier; and the figure is never truncated.
 * </p>
 *
 * <p>
 * The resting look is quieter than before — a neutral pill with a green wallet — because a chip
 * that is always green is a chip that stops meaning anything. Low turns it amber, empty turns it
 * red, and those two are the states worth a colour.
 * </p>
 */

/** 6 000 ms, not the 4 000 default. Money deserves reading time, and it is dismissible. */
const MONEY_TOAST_MS = 6_000;

/** Both halves of the club-movement sentence, in one place. No "just now": it may be 30s old. */
function clubMovementSentence(amount: number): string {
  const credits = Math.abs(amount).toFixed(2);
  return amount > 0
    ? `The club added ${credits} credits to your wallet.`
    : `The club took ${credits} credits off your wallet.`;
}

const TONE = {
  zero: "bg-danger-soft text-danger-strong hover:bg-danger-soft/80",
  low: "bg-warning-soft text-warning-strong hover:bg-warning-soft/80",
  fine: "bg-bg-muted text-text-primary hover:bg-bg-muted/70",
} as const;

const ICON_TONE = { zero: "", low: "", fine: "text-success-strong" } as const;

function useClubMovementToast() {
  const { delta, clearDelta } = useBalance();
  const toast = useToast();
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!delta) return;
    if (announced.current === delta.at) return;
    announced.current = delta.at;
    if (delta.source === "club") {
      toast.push({ tone: delta.amount > 0 ? "success" : "info", text: clubMovementSentence(delta.amount), durationMs: MONEY_TOAST_MS });
    }
    // The flyout lives 900 ms; clearing after it keeps a re-render from replaying it.
    const t = window.setTimeout(clearDelta, 1_000);
    return () => window.clearTimeout(t);
  }, [delta, toast, clearDelta]);
}

/** The chip's hover title: the stream's health first, then what is held, then the plain one. */
function chipTitle(state: string, loading: boolean, heldCredits: number, owedBack: number): string {
  if (state === "degraded") return "The club's live updates aren't coming through — this figure is checked every 30 seconds.";
  if (loading) return "Refreshing balance…";
  return heldCredits > 0 || owedBack > 0 ? chipHeldTitle(heldCredits, owedBack) : "Wallet balance — tap to top up";
}

export function CreditsChip() {
  const { balance, loading, state, delta, held } = useBalance();
  // D11 §3a — the figure stays the whole balance; the name and title say what of it is held.
  const heldCredits = held && held.held > 0 ? held.held : 0;
  // P11 — and what of it is owed back to partners, paid from the next credit in.
  const owedBack = held?.owedBack ?? 0;
  const location = useLocation();
  const reduceMotion = usePrefersReducedMotion();
  const tone = walletTone(balance);
  const displayed = useCountUp(balance, { instant: reduceMotion });
  const entice = useZeroBalanceEntice({ atZero: tone === "zero", reduceMotion });
  useClubMovementToast();

  // Arriving at the wallet by ANY route — the chip, a toast link, a typed URL, Back — is an answer.
  useEffect(() => {
    if (location.pathname.startsWith("/wallet")) entice.stop("arrived");
  }, [location.pathname, entice]);

  const showFlyout = !reduceMotion && delta !== null && Math.abs(delta.amount) >= 0.01;

  return (
    <div className="relative shrink-0">
      <Link
        to={walletHref(balance)}
        onClick={() => entice.stop("tapped")}
        data-credits-chip=""
        data-zero-entice={entice.breathing || undefined}
        data-live-state={state}
        aria-label={walletLabel(balance, loading, state, heldCredits, owedBack)}
        title={chipTitle(state, loading, heldCredits, owedBack)}
        className={cn(
          // A 44px floor in PIXELS at every pointer (it sits beside the 44px account button, and
          // on a phone it is a fingertip target), and no fixed height: at a 32px root the figure
          // is 28px tall and a box that did not grow with it would clip the number (B12).
          "no-lift inline-flex min-h-touch shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3",
          "text-sm font-semibold tabular-nums transition-colors duration-in ease-out motion-reduce:transition-none",
          TONE[tone],
          entice.breathing && "animate-chip-breathe motion-reduce:animate-none",
        )}
      >
        <Wallet size={16} weight="fill" aria-hidden="true" className={cn("shrink-0", ICON_TONE[tone])} />
        {/* aria-hidden: the label says the number in words; "cr" is not a word. Never truncated. */}
        <span aria-hidden="true">{balance === null ? "— cr" : formatCredits(displayed)}</span>
        {entice.showWord ? <span aria-hidden="true">· Top up</span> : null}
        {state === "degraded" ? (
          <span aria-hidden="true" className="ml-0.5 inline-block size-1 rounded-full border border-current opacity-70" />
        ) : null}
      </Link>
      {showFlyout ? (
        // Up is success; down is secondary, deliberately not red — spending your own credit on a
        // court you chose is not an error.
        <span
          aria-hidden="true"
          data-balance-flyout=""
          className={cn(
            "pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 text-xs font-semibold tabular-nums",
            "animate-flyout-rise motion-reduce:animate-none",
            delta!.amount > 0 ? "text-success-strong" : "text-text-secondary",
          )}
        >
          {delta!.amount > 0 ? "+" : "−"}{Math.abs(delta!.amount).toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}
