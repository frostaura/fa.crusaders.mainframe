import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Wallet as WalletIcon } from "lucide-react";
import { useBalance, walletHref, walletLabel, walletTone } from "../lib/balance";
import { useCountUp, usePrefersReducedMotion } from "../lib/useCountUp";
import { useZeroBalanceEntice } from "../lib/zeroBalanceEntice";
import { useToast } from "./Toast";
import { cn, formatCredits } from "../lib/utils";

/**
 * Item 8 — the credits badge.
 *
 * <p>
 * Lifted out of `Layout` because it stopped being a `NavLink` with a class on it: it counts,
 * it changes colour across three states rather than two, it breathes a finite number of times
 * at zero, it raises exactly one toast when the club pays a member, and it says so when the
 * figure it is showing is no longer live. A hundred lines of that inside a header component is
 * a hundred lines nobody can test on its own.
 * </p>
 *
 * <p>
 * <b>What a member sees when an admin tops them up while they watch</b> — the case GOAL 8 is
 * really about, because a number silently changing in a header corner is not an event anybody
 * notices:
 * </p>
 *
 * <pre>
 * t=0      the stream delivers balance_credits: 200.00   (previous 0.00)
 * t=0      the zero-state entice stops, permanently
 * t=0      the chip cross-fades danger-soft -> success-soft over --fb-in (180 ms)
 * t=0      the flyout "+200.00" rises and fades over 900 ms          [aria-hidden]
 * t=0..900 the figure counts 0.00 -> 200.00, easeOutCubic            [aria-hidden]
 * t=0      TOAST, tone success, 6 000 ms:
 *          "The club added 200.00 credits to your wallet."           [role=status]
 * t~900    the chip settles at 200.00 cr, green
 * </pre>
 *
 * <p>
 * <b>The toast is not decoration, it is the accessibility requirement.</b> A `NavLink`'s
 * `aria-label` changing is NOT an announcement — it is not inside a live region and no screen
 * reader will read it. Without the toast a blind member is never told the club paid them. The
 * toast already carries `role="status"` per instance and the viewport deliberately carries
 * none, so this is exactly one announcement.
 * </p>
 */

/** 6 000 ms, not the 4 000 default. Money deserves reading time, and it is dismissible. */
const MONEY_TOAST_MS = 6_000;

/** Both halves of the conditional, in one place, so neither can be written twice. */
export function clubMovementSentence(amount: number): string {
  const credits = Math.abs(amount).toFixed(2);
  // No "just now": under the degraded poll this may be up to thirty seconds old, and a
  // sentence that claims a time it cannot know is the class of defect the whole state machine
  // above exists to avoid.
  return amount > 0
    ? `The club added ${credits} credits to your wallet.`
    : `The club took ${credits} credits off your wallet.`;
}

const TONE_CLASS = {
  // Three states, three looks. 0.00 and 49.99 used to be the identical amber, and a member
  // with nothing in their wallet was told they were "running low".
  zero: "bg-danger-soft text-danger-strong hover:bg-danger-soft/80",
  low: "bg-warning-soft text-warning-strong hover:bg-warning-soft/80",
  fine: "bg-success-soft text-success-strong hover:bg-success-soft/80",
} as const;

export function CreditsBadge() {
  const { balance, loading, state, delta, clearDelta } = useBalance();
  const toast = useToast();
  const location = useLocation();
  const reduceMotion = usePrefersReducedMotion();
  const tone = walletTone(balance);
  const displayed = useCountUp(balance, { instant: reduceMotion });

  const entice = useZeroBalanceEntice({ atZero: tone === "zero", reduceMotion });

  /**
   * Arriving at the wallet is an answer. Stops the entice for the rest of the session.
   *
   * By ANY route — a tap on the chip, a link in a toast, a typed URL, the browser's Back
   * button. The chip's own `onClick` would catch one of those four.
   */
  useEffect(() => {
    if (location.pathname.startsWith("/wallet")) entice.stop("arrived");
  }, [location.pathname, entice]);

  /**
   * One toast per club movement, and none for the member's own.
   *
   * <p>
   * A member who just pressed <em>Book</em> already has a toast; raising a second would be the
   * double-announcement defect in a new costume. `delta.source` is set by `apply()` — which
   * every booking and cancel already calls with the server's own figure — so "this tab caused
   * it" is a fact rather than a guess.
   * </p>
   */
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

  const showFlyout = !reduceMotion && delta !== null && Math.abs(delta.amount) >= 0.01;

  return (
    <div className="relative shrink-0">
      <NavLink
        to={walletHref(balance)}
        onClick={() => entice.stop("tapped")}
        className={({ isActive }) => cn(
          // C16 — 36 px is not a touch target. `h-11` (44 px) on a coarse pointer only: the
          // constraint is a fingertip, and a 44 px chip in a desktop header has stopped being
          // a chip. B12 — every length in PIXELS, and no truncation: a `max-w` with `truncate`
          // rendered a balance of 0 as "0…", and a wallet chip that abbreviates the one number
          // it exists to show has stopped being a wallet chip.
          "inline-flex shrink-0 items-center gap-[6px] min-h-[36px] [@media(pointer:coarse)]:min-h-[44px] px-[12px] rounded-lg text-sm font-medium tabular-nums whitespace-nowrap max-w-[calc(100vw-32px)]",
          "transition-colors duration-in ease-out",
          TONE_CLASS[tone],
          isActive && "ring-1 ring-accent-strong/30",
          // `animate-chip-breathe` runs three iterations and stops by itself; the cadence
          // around it decides whether the class is on at all. `motion-reduce:` as well as the
          // hook's own guard, because there is no global rule that stands Tailwind's animation
          // shorthand down.
          entice.breathing && "animate-chip-breathe motion-reduce:animate-none",
        )}
        data-zero-entice={entice.breathing || undefined}
        data-live-state={state}
        /*
          The NUMBER, in the name. This was `aria-label="Wallet balance"`, and an aria-label
          REPLACES an element's contents — so a screen reader announced "Wallet balance, link"
          and the balance itself, the only thing in the chrome that says whether a member can
          afford to book, was never read out at all.
        */
        aria-label={walletLabel(balance, loading, state)}
        title={state === "degraded"
          ? "The club's live updates aren't coming through — this figure is checked every 30 seconds."
          : loading ? "Refreshing balance…" : "Wallet balance — tap to top up"}
      >
        <WalletIcon size={14} strokeWidth={2.25} className="shrink-0" />
        {/* aria-hidden: the label above already says the number, and the visible text
            abbreviates it to "cr", which is not a word. No `truncate` — B12. */}
        <span aria-hidden="true">{balance === null ? "— cr" : formatCredits(displayed)}</span>
        {entice.showWord && (
          /**
           * The reduced-motion variant is a DIFFERENT affordance, not a quieter one.
           *
           * There is no slow pulse. The chip grows a word, once, and keeps it for as long as
           * the balance is zero. A static thing that is always there is strictly better for
           * this audience than motion they have asked not to see, and it is the same
           * information — so it is `aria-hidden`, because the label already says "You can't
           * book until you top up".
           */
          <span aria-hidden="true" className="font-semibold">· Top up</span>
        )}
        {state === "degraded" && (
          /* A 4 px hollow dot, and the `title` above says what it means. The number is never
             shown without the qualifier — a stream that has silently died leaving a confident
             stale figure is the defect this closes. */
          <span
            aria-hidden="true"
            className="ml-[2px] inline-block h-[4px] w-[4px] rounded-full border border-current opacity-70"
          />
        )}
      </NavLink>
      {showFlyout && (
        /**
         * Up is `success-strong`. Down is `text-secondary` — deliberately not red.
         *
         * Spending your own credit on a court you chose is not an error, and a red number in
         * the header over a successful booking is the app telling a member off for using it.
         * Red is reserved for money leaving unexpectedly, which in this product is only the
         * cancellation penalty — and that has its own dialog with the figure in it.
         */
        <span
          aria-hidden="true"
          data-balance-flyout
          className={cn(
            "pointer-events-none absolute left-1/2 -translate-x-1/2 -top-1 text-xs font-semibold tabular-nums",
            "animate-flyout-rise motion-reduce:animate-none",
            delta!.amount > 0 ? "text-success-strong" : "text-text-secondary",
          )}
        >
          {delta!.amount > 0 ? "+" : "−"}{Math.abs(delta!.amount).toFixed(2)}
        </span>
      )}
    </div>
  );
}
