import { Link } from "react-router-dom";
import { intentProps } from "@/routeChunks";
import { UPCOMING } from "@/lib/bookingsCopy";
import { bookingsApi, type UpcomingGame } from "@/lib/bookingsApi";
import { memberReads } from "@/lib/offline/memberReads";
import { RESULT_READABLE } from "@/lib/bookingLink";
import { cn } from "@/lib/utils";
import { useGamesRead } from "./useGamesRead";
import { when } from "./gameWhen";

/**
 * The member's upcoming games as one line that drifts sideways, stock-ticker style — every game
 * always in view without a card list taking the grid's room.
 *
 * <p>
 * The line is drawn twice, so half its width is one seamless loop; the copy is `inert` and
 * hidden from assistive tech. It pauses under a pointer or focus, and with reduced motion it does
 * not move at all — it is a plain row the member scrolls. A game that needs the member says so.
 * Quiet when there are no games, and when the read fails or the phone is offline with nothing
 * kept: the page's own states say those, a ticker would only repeat them.
 * </p>
 */
const SECONDS_PER_GAME = 8;

export function UpcomingTicker({ refreshKey, fallbackZone, className }: { refreshKey: unknown; fallbackZone?: string; className?: string }) {
  const { state } = useGamesRead(bookingsApi.upcoming, refreshKey, memberReads.upcoming.key);
  if (state.status !== "ready" || state.items.length === 0) return null;
  const zone = state.timezone ?? fallbackZone;
  const duration = `${Math.max(20, state.items.length * SECONDS_PER_GAME)}s`;
  return (
    <section
      aria-label={UPCOMING.tickerLabel} data-upcoming-ticker=""
      className={cn("group flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-border bg-bg-surface px-3", className)}
    >
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-text-secondary">{UPCOMING.tickerLabel}</span>
      <div className="min-w-0 flex-1 overflow-x-auto motion-safe:overflow-hidden">
        <div
          style={{ ["--ticker-duration" as string]: duration }}
          className="flex w-max motion-safe:animate-ticker-scroll motion-safe:group-hover:[animation-play-state:paused] motion-safe:group-focus-within:[animation-play-state:paused]"
        >
          <Run games={state.items} zone={zone} />
          <Run games={state.items} zone={zone} copy />
        </div>
      </div>
    </section>
  );
}

function Run({ games, zone, copy = false }: { games: readonly UpcomingGame[]; zone: string | undefined; copy?: boolean }) {
  return (
    <ul className="flex shrink-0 items-center" aria-hidden={copy || undefined} {...(copy ? { inert: true } : {})}>
      {games.map((game) => (
        <li key={game.booking_id} className="shrink-0">
          <Link
            to={`/bookings/${game.booking_id}`} {...intentProps(`/bookings/${game.booking_id}`)} state={RESULT_READABLE}
            className="flex min-h-touch items-center gap-2 whitespace-nowrap px-3 text-sm tabular-nums text-text-primary"
          >
            <span className="font-semibold">{game.court_name}</span>
            <span className="text-text-secondary">{when(game, zone)}</span>
            {game.needs_action ? <span className="font-semibold text-warning-strong">· {UPCOMING.needsAction}</span> : null}
            <span aria-hidden="true" className="pl-3 text-text-muted">•</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
