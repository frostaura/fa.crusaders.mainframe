import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarCheck } from "lucide-react";
import type { MemberDoorBooking } from "../../lib/api";
import { clubClock } from "../../lib/clubClock";
import { useCountdownSeconds } from "../member-door/useCountdownSeconds";
import { Button } from "../Button";
import { Card } from "../Card";
import {
  GUIDE_PATH, WHATS_NEXT_DISMISS, WHATS_NEXT_DISMISS_KEY, WHATS_NEXT_MORE, WHATS_NEXT_TITLE,
  whatsNextSteps,
} from "../../lib/onboardingCopy";

/**
 * The one thing item 16 PUSHES: what happens next, about the booking you actually have.
 *
 * <p>
 * Until this, the only feedback after a successful booking was a toast that lived four
 * seconds, after which the member was looking at a grid. Nothing told them what to bring,
 * where to go, or what to press — and the audience the goal note describes is exactly the one
 * that will not go looking.
 * </p>
 *
 * <p>
 * <b>It persists until the booking ends</b>, which is what makes it useful in the car park
 * rather than only in the second after pressing Book. It is dismissible, and dismissing it
 * dismisses it for THAT booking: the stored value is the booking's own end instant, so it
 * re-arms by itself for the next one. A list of booking ids would have to be pruned to
 * achieve the same thing.
 * </p>
 *
 * <p>
 * <b>Where it renders, and the one place it does not yet.</b> Home and the code page, both of
 * which a member opens on the way to the club. It belongs above the schedule grid as well —
 * that is the screen a member is on the instant a booking succeeds — and that page belongs to
 * another lane in this programme. Dropping it in is one line:
 * <code>&lt;WhatsNextCard booking={...} timezone={day.timezone} /&gt;</code> above the grid.
 * </p>
 *
 * <p>
 * <b>Announcement.</b> None. The booking toast already says the court and the time, and a
 * second live region for the same event is the defect `Toast.tsx` records having paid for
 * twice. This is a standing card on a screen somebody has arrived at, not an event.
 * </p>
 */

/** Read once, lazily — a clock read in a render body is not pure. */
function dismissedUntil(): number {
  try {
    const raw = window.localStorage?.getItem(WHATS_NEXT_DISMISS_KEY);
    const at = raw ? Date.parse(raw) : NaN;
    return Number.isNaN(at) ? 0 : at;
  } catch {
    // Private mode, or storage the browser has taken away. The card simply shows; it is not
    // worth a failure, and the member can dismiss it again.
    return 0;
  }
}

export type WhatsNextCardProps = {
  /** The member's next booking, from `/me/door`. Null renders nothing at all. */
  booking: MemberDoorBooking | null | undefined;
  /** The club's own zone, so both clock faces are the club's day. */
  timezone?: string;
  /** Does this club have door scanners? Absent keeps the door line — see `guideSteps`. */
  doors?: "yes" | "no" | "unknown";
  /** The door's unlock dwell, when anything a member can read ever carries it. */
  unlockSeconds?: number | null;
};

export function WhatsNextCard({ booking, timezone, doors, unlockSeconds }: WhatsNextCardProps) {
  const [suppressedUntil, setSuppressedUntil] = useState(dismissedUntil);
  /*
    Read off the clock through the page's own ticker, never in the render body — the same rule
    the code page's countdown follows, and for the same reason: a phone in a pocket fires no
    ticks, and a card that decided it was still relevant at the moment React last rendered is
    a card still telling somebody what happens next an hour after their court went dark.
  */
  const secondsLeft = useCountdownSeconds(booking?.ends_at ?? null);

  const dismiss = useCallback(() => {
    if (!booking) return;
    // A parse that fails yields 0, which suppresses nothing — better than a card that
    // disappears for ever on a malformed instant.
    setSuppressedUntil(Date.parse(booking.ends_at) || 0);
    try {
      window.localStorage?.setItem(WHATS_NEXT_DISMISS_KEY, booking.ends_at);
    } catch { /* the in-memory state above is enough for this visit */ }
  }, [booking]);

  if (!booking) return null;
  // Already over: the card is about what happens next, and nothing does.
  if (secondsLeft !== null && secondsLeft <= 0) return null;
  // Dismissed for this booking, or for one that ends no earlier than it.
  const ends = Date.parse(booking.ends_at);
  if (!Number.isNaN(ends) && suppressedUntil >= ends) return null;

  const lines = whatsNextSteps(
    {
      courtNumber: booking.court_number ?? null,
      startsClock: clubClock(booking.starts_at, timezone),
      endsClock: clubClock(booking.ends_at, timezone),
    },
    { doors, unlockSeconds },
  );

  return (
    <Card className="space-y-3 border-l-4 border-accent-strong">
      <h2 className="flex items-center gap-2 text-base font-medium">
        <CalendarCheck size={18} className="shrink-0 text-accent-strong" aria-hidden="true" />
        {WHATS_NEXT_TITLE}
      </h2>
      {/* An ordered list with real list items, because a stepper is a list. No `aria-current`,
          no roving tabindex: this is static content, not a widget with something to learn. */}
      <ol className="space-y-2 text-sm text-text-secondary">
        {lines.map((line, index) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="font-medium text-text-muted">{index + 1}.</span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" onClick={dismiss} className="w-full sm:w-auto">{WHATS_NEXT_DISMISS}</Button>
        <Link
          to={GUIDE_PATH}
          className="inline-flex min-h-11 items-center text-sm text-accent-strong underline underline-offset-2 hover:no-underline"
        >
          {WHATS_NEXT_MORE}
        </Link>
      </div>
    </Card>
  );
}
