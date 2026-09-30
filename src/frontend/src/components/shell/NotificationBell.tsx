import { Link, useLocation } from "react-router-dom";
import { useUnreadCount, useUnreadCountDriver } from "@/components/inbox/useUnreadCount";
import { Bell } from "@/components/ui/icons";
import { bellBadge, bellLabel } from "@/lib/bellCopy";
import { cn } from "@/lib/utils";

/**
 * The bell in the top bar (P11, D11): a LINK to `/inbox` — it navigates, so it is not an icon
 * button — 44px square, with the unread count as a badge (1–9, then "9+").
 *
 * <p>
 * The digits are decoration; the accessible name carries the number in words ("Notifications,
 * 3 unread"). A zero, and a count nobody has read yet, render no badge — and a failed read is
 * simply no badge: the bell is a cue, not a screen.
 * </p>
 *
 * <p>
 * It is also the one component that DRIVES the shared count (the stream frame, the first read,
 * the fallback poll), because it is mounted exactly once for as long as a member is signed in.
 * </p>
 */
/**
 * R4 (V4-11): the badge's box grows with the text only to 28px and never rises more than 10px
 * above the glyph — its normal-text overhang. At 200 % text a 1.25rem badge hung 20px above a
 * 1.25rem glyph and was cut by the top of the screen; growing the bell's own box instead made the
 * top bar 99px taller (B12 allows 45). A style, since utilities outside `ui/` may not use
 * arbitrary lengths.
 */
const BADGE_BOX = {
  top: "max(-0.625rem, -10px)",
  height: "min(1.25rem, 28px)",
  minWidth: "min(1.25rem, 28px)",
} as const;

export function NotificationBell({ className }: { className?: string }) {
  useUnreadCountDriver();
  const { count } = useUnreadCount();
  const { pathname } = useLocation();
  const badge = bellBadge(count);
  const here = pathname === "/inbox";
  return (
    <Link
      to="/inbox"
      data-notification-bell=""
      aria-label={bellLabel(count)}
      aria-current={here ? "page" : undefined}
      className={cn(
        "no-lift relative inline-flex size-touch shrink-0 items-center justify-center rounded-full border border-transparent",
        "text-text-secondary transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary motion-reduce:transition-none",
        here && "bg-accent-soft text-accent-strong",
        className,
      )}
    >
      {/*
        F4-7 — the glyph scales with the text (rem, not a fixed 20px) and the badge hangs off the
        glyph's top-right corner rather than the link's: at 200 % text the 20px bell stayed 20px
        while the badge doubled, and the badge sat squarely on top of the bell.
      */}
      <span className="relative inline-flex">
        <Bell weight={here ? "fill" : "regular"} aria-hidden="true" data-bell-glyph="" className="size-5" />
        {badge ? (
          <span
            aria-hidden="true"
            data-unread-badge=""
            className={cn(
              "absolute left-2/3 inline-flex items-center justify-center rounded-full px-1",
              "bg-danger-solid text-xs font-semibold leading-none tabular-nums text-danger-ink ring-2 ring-bg-surface",
            )}
            style={BADGE_BOX}
          >
            {badge}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
