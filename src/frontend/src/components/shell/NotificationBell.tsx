import { Link, useLocation } from "react-router-dom";
import { useUnreadCount, useUnreadCountDriver } from "@/components/inbox/useUnreadCount";
import { Bell } from "@/components/ui/icons";
import { bellBadge, bellLabel } from "@/lib/playersCopy";
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
        "no-lift relative inline-flex size-touch shrink-0 items-center justify-center rounded-full border border-transparent",
        "text-text-secondary transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary motion-reduce:transition-none",
        here && "bg-accent-soft text-accent-strong",
        className,
      )}
    >
      <Bell size={20} weight={here ? "fill" : "regular"} aria-hidden="true" />
      {badge ? (
        <span
          aria-hidden="true"
          data-unread-badge=""
          className={cn(
            "absolute right-0.5 top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1",
            "bg-danger-solid text-xs font-semibold tabular-nums text-danger-ink ring-2 ring-bg-surface",
          )}
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
}
