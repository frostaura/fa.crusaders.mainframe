import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Wallet } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { useBalance, walletHref, walletLabel, walletTone } from "@/lib/balance";
import type { BalanceDelta, LiveState } from "@/lib/liveBalance";
import { useCountUp, usePrefersReducedMotion } from "@/lib/useCountUp";
import { useZeroBalanceEntice } from "@/lib/zeroBalanceEntice";
import { cn, formatCredits } from "@/lib/utils";
import { movementSentence } from "@/lib/walletCopy";
import { useAuth } from "@/lib/auth";
import { useChipBalance, type ChipFigures } from "./chipBalance";
import { namedShareMovement } from "./shareMovement";
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

const TONE = {
  zero: "bg-danger-soft text-danger-strong hover:bg-danger-soft/80",
  low: "bg-warning-soft text-warning-strong hover:bg-warning-soft/80",
  fine: "bg-bg-muted text-text-primary hover:bg-bg-muted/70",
} as const;

const ICON_TONE = { zero: "", low: "", fine: "text-success-strong" } as const;

/**
 * One toast for a movement this tab did not cause (D4) — worded from the frame's reason, and for
 * a share with the names in it. A movement of the member's own (`source: "self"`) raises none: the
 * page that caused it has already said what happened.
 */
function useClubMovementToast() {
  const { delta, clearDelta } = useBalance();
  const auth = useAuth();
  const me = auth.status === "authenticated" ? auth.userId : null;
  const toast = useToast();
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!delta) return;
    if (announced.current === delta.at) return;
    announced.current = delta.at;
    if (delta.source === "club") {
      const say = (text: string) => toast.push({ tone: delta.amount > 0 ? "success" : "info", text, durationMs: MONEY_TOAST_MS });
      const plain = movementSentence(delta.amount, delta.reason);
      if (delta.reason === "share_transfer") {
        namedShareMovement(delta.amount, me).then((named) => say(named ?? plain), () => say(plain));
      } else {
        say(plain);
      }
    }
  }, [delta, toast, me]);

  // The flyout lives 900 ms; clearing after it keeps a re-render from replaying it. Its own effect
  // (M-1): inside the toast's, a re-run for a new `toast` identity cancelled the timer and then
  // returned early as "already announced", so the movement was never cleared.
  useEffect(() => {
    if (!delta) return;
    const t = window.setTimeout(clearDelta, 1_000);
    return () => window.clearTimeout(t);
  }, [delta, clearDelta]);
}

/** ", 20.00 held for partners, 16.00 owed back to partners" — the parts, in words. */
function partsInWords(f: ChipFigures): string {
  const held = f.held > 0 ? `, ${f.held.toFixed(2)} held for partners` : "";
  const owed = f.owedBack > 0 ? `, ${f.owedBack.toFixed(2)} owed back to partners` : "";
  return `${held}${owed}`;
}

/**
 * The accessible name. Unparted, exactly `walletLabel`. Parted: the spendable figure first, then
 * the whole balance with its parts — "Wallet balance 500.00 credits to spend — 550.00 credits,
 * 50.00 held for partners. Tap to top up." The tone sentence follows the SPENDABLE figure, as the
 * chip's colour does: a member with nothing to spend cannot book, whatever the whole says.
 */
function chipLabel(balance: number | null, loading: boolean, state: LiveState, f: ChipFigures): string {
  if (!f.parted || balance === null || f.shown === null) return walletLabel(balance, loading, state, f.held, f.owedBack);
  const spend = f.shown > 0 ? `${f.shown.toFixed(2)} credits to spend` : "nothing to spend";
  const tone = walletTone(f.shown);
  const next = tone === "zero" ? " You can't book until you top up. Tap to top up." : tone === "low" ? " Running low. Tap to top up." : " Tap to top up.";
  const stale = state === "degraded" ? " This figure is checked every 30 seconds." : "";
  return `Wallet balance ${spend} — ${balance.toFixed(2)} credits${partsInWords(f)}.${next}${stale}`;
}

/** The chip's hover title: the stream's health first, then what is set aside, then the plain one. */
function chipTitle(state: string, loading: boolean, balance: number | null, f: ChipFigures): string {
  if (state === "degraded") return "The club's live updates aren't coming through — this figure is checked every 30 seconds.";
  if (loading) return "Refreshing balance…";
  if (!f.parted || balance === null || f.shown === null) return "Wallet balance — tap to top up";
  const parts = [
    f.held > 0 ? `${formatCredits(f.held)} held for partners${f.heldParts ? ` (${f.heldParts})` : ""}` : null,
    f.owedBack > 0 ? `${formatCredits(f.owedBack)} owed back to partners` : null,
  ].filter(Boolean).join(", ");
  return `${formatCredits(Math.max(0, f.shown))} to spend — ${formatCredits(balance)} in your wallet, ${parts}. Tap to top up.`;
}

/**
 * M-1 (review round 3) — frames closer together than this are ONE movement to the eye: the flyout
 * lives 900 ms, and a split booking's cancel lands as a burst (the organiser's refund, then each
 * partner's share back to them) inside a few milliseconds.
 */
const BURST_MS = 1_000;

type Burst = { from: number | null; last: number | null; at: number; startedAt: number };

/**
 * What the flyout says: the NET change of the figure the chip shows, across the current burst —
 * not the last frame's `delta_minutes`. That read "−33.00" while the chip counted 235 → 335. Null
 * when there is no movement to show, or the burst nets to nothing the chip shows (a partner's paid
 * share that is only HELD moves the balance but not the spendable figure on the chip).
 *
 * <p>
 * Derived during render from the previous render's figure (React's "information from previous
 * renders" pattern), because the figure and the movement arrive in the same update.
 * </p>
 */
function useFlyoutAmount(shown: number | null, delta: BalanceDelta | null): { amount: number; key: number } | null {
  const [burst, setBurst] = useState<Burst>({ from: shown, last: shown, at: 0, startedAt: 0 });
  if (delta && delta.at !== burst.at) {
    const fresh = burst.from === null || delta.at - burst.at > BURST_MS;
    setBurst(fresh
      ? { from: burst.last, last: shown, at: delta.at, startedAt: delta.at }
      : { ...burst, last: shown, at: delta.at });
  } else if (shown !== burst.last) {
    setBurst({ ...burst, last: shown });
  }
  if (!delta || shown === null || burst.from === null) return null;
  const net = shown - burst.from;
  // Keyed by the burst, so a new movement replays the rise and one burst's frames do not restart it.
  return Math.abs(net) >= 0.005 ? { amount: net, key: burst.startedAt } : null;
}

/**
 * The figure — or, while it is loading, a neutral placeholder the width of one (D1). Never a
 * zero: a loading chip once painted a red "0.00 cr" that belonged to nobody signed in.
 * aria-hidden: the label says the number in words; "cr" is not a word. Never truncated.
 */
function ChipFigure({ balance, loading, displayed }: { balance: number | null; loading: boolean; displayed: number }) {
  if (balance === null && loading) return <Skeleton className="h-4 w-14 rounded-full bg-border" />;
  return <span aria-hidden="true">{balance === null ? "— cr" : formatCredits(displayed)}</span>;
}

/** "Last known at 18:04 — …": a kept figure says it is one. */
function keptTitle(at: number | null, rest: string): string {
  const time = at === null ? null : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${time ? `Last known at ${time}` : "Last known"}, not yet confirmed by the club — ${rest}`;
}

export function CreditsChip() {
  const { live, kept, balance, loading, figures } = useChipBalance();
  const { state, delta } = live;
  const location = useLocation();
  const reduceMotion = usePrefersReducedMotion();
  const tone = walletTone(figures.shown);
  const displayed = useCountUp(figures.shown, { instant: reduceMotion });
  const entice = useZeroBalanceEntice({ atZero: tone === "zero", reduceMotion });
  useClubMovementToast();

  // Arriving at the wallet by ANY route — the chip, a toast link, a typed URL, Back — is an answer.
  useEffect(() => {
    if (location.pathname.startsWith("/wallet")) entice.stop("arrived");
  }, [location.pathname, entice]);

  const flyout = useFlyoutAmount(figures.shown, delta);
  const showFlyout = !reduceMotion && flyout !== null;

  return (
    // V5-4 (review round 5): folded away where the bar is under 17.5rem — a phone at large text,
    // where crest, bell, chip and avatar cannot share one row (320 px at 200 %: the header took
    // two rows). The account menu then shows the figure (`AccountMenu`), and the Wallet tab is one
    // tap away. Still mounted, so its money toasts still speak.
    <div data-credits-chip-slot="" className="relative hidden shrink-0 @[17.5rem]/appbar:block">
      <Link
        to={walletHref(figures.shown)}
        onClick={() => entice.stop("tapped")}
        data-credits-chip=""
        data-zero-entice={entice.breathing || undefined}
        data-live-state={state}
        aria-label={chipLabel(balance, loading, state, figures)}
        title={kept ? keptTitle(kept.at, chipTitle(state, loading, balance, figures)) : chipTitle(state, loading, balance, figures)}
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
        <ChipFigure balance={figures.shown} loading={loading} displayed={displayed} />
        {entice.showWord ? <span aria-hidden="true">· Top up</span> : null}
        {state === "degraded" ? (
          <span aria-hidden="true" className="ml-0.5 inline-block size-1 rounded-full border border-current opacity-70" />
        ) : null}
      </Link>
      {showFlyout ? (
        // Up is success; down is secondary, deliberately not red — spending your own credit on a
        // court you chose is not an error.
        <span
          key={flyout!.key}
          aria-hidden="true"
          data-balance-flyout=""
          className={cn(
            "pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 text-xs font-semibold tabular-nums",
            "animate-flyout-rise motion-reduce:animate-none",
            flyout!.amount > 0 ? "text-success-strong" : "text-text-secondary",
          )}
        >
          {flyout!.amount > 0 ? "+" : "−"}{Math.abs(flyout!.amount).toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}
