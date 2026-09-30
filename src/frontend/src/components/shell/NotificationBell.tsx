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
        // R4 (V4-11): a floor, not a size, padded by the badge's overhang (half its 1.25rem height
        // above a 1.25rem glyph): at 200 % text the badge rose 20px above the glyph and was cut by
        // the top of the screen. At normal text this is the same 44px circle.
        "no-lift relative inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-full border border-transparent p-2.5",
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
              "absolute bottom-1/2 left-2/3 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1",
              "bg-danger-solid text-xs font-semibold tabular-nums text-danger-ink ring-2 ring-bg-surface",
            )}
          >
            {badge}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
