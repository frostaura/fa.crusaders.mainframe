import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * The club's crest mark — a shield in crest blue with the red cross of the Crusaders, drawn
 * rather than shipped as an image so it is crisp at every density and needs no request.
 *
 * <p>
 * Crest red ("tin") is used for exactly two things in the product: this mark and the booking
 * grid's now-line (design-system.md). The brand band keeps its navy in the dark theme, so the
 * shield reads the same in both; the white keyline is `brand-ink`, which is white in both.
 * </p>
 */
export function CrestMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 36" aria-hidden="true" focusable="false" className={cn("h-touch w-auto shrink-0", className)}>
      <path d="M16 1 30 5.5V17c0 8.6-6 14.6-14 18C8 31.6 2 25.6 2 17V5.5Z" className="fill-brand-strong" />
      <path
        d="M16 4.2 27 7.7V17c0 6.9-4.6 11.9-11 14.9C9.6 28.9 5 23.9 5 17V7.7Z"
        className="fill-none stroke-brand-ink"
        strokeWidth="1.25"
        strokeOpacity="0.85"
      />
      <path d="M14.2 9h3.6v5.4h5.4V18h-5.4v8.6h-3.6V18H8.8v-3.6h5.4Z" className="fill-brand-tin" />
    </svg>
  );
}

/**
 * The crest and the club's name, as the way home. The name truncates first — it is the one thing
 * in the top bar that carries no action of its own — and is shown only where the bar has room for
 * it: hidden on a phone (the chip and the avatar need the width) and where the four tabs have just
 * joined the bar (44–60rem). In the BAR's rem (`@container/appbar`, V5-3), not the viewport's, so
 * at 200 % text it gives the room back instead of pushing the row onto three lines. Its
 * accessible name is always the club.
 */
export function CrestLink({ to }: { to: string }) {
  return (
    <Link
      to={to}
      data-crest-link=""
      aria-label="Crusaders Squash — home"
      className="no-lift flex min-h-touch min-w-touch items-center justify-center gap-2.5 rounded-lg"
    >
      <CrestMark />
      <span aria-hidden="true" className="hidden min-w-0 truncate font-display text-lg font-bold tracking-tight text-text-primary @[24rem]/appbar:block @[44rem]/appbar:hidden @[60rem]/appbar:block">
        Crusaders Squash
      </span>
    </Link>
  );
}
