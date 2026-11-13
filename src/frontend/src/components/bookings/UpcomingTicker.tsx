import { useCallback, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Link } from "react-router-dom";
import { IconButton } from "@/components/ui/icon-button";
import { Pause, Play } from "@/components/ui/icons";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { intentProps } from "@/routeChunks";
import { TICKER } from "@/lib/tickerCopy";
import { bookingsApi, type UpcomingGame } from "@/lib/bookingsApi";
import { memberReads } from "@/lib/offline/memberReads";
import { RESULT_READABLE } from "@/lib/bookingLink";
import { cn } from "@/lib/utils";
import { useGamesRead } from "./useGamesRead";
import { clubClock, clubShortDate } from "@/lib/clubClock";

/**
 * The member's upcoming games as one line that drifts sideways, stock-ticker style — every game
 * always in view without a card list taking the grid's room.
 *
 * <p>
 * <b>It moves only when it has to, and the member can stop it</b> (go-live FM-5, WCAG 2.2.2 Pause,
 * Stop, Hide). A line that fits its strip is a still row, drawn once — the doubled run used to leave
 * most of a wide strip empty while it scrolled, and read every game twice (BM-18g). A line wider than
 * its strip drifts, drawn twice so half its width is one seamless loop (the copy `inert` and hidden
 * from assistive tech), and carries a Pause / Play button a touch screen can press: hover and focus
 * pause it too, but a finger never hovers. Paused, it is a plain row the member scrolls by hand; the
 * choice is remembered on this phone. With reduced motion it never moves. A game that needs the
 * member says so. Quiet when there are no games, and when the read fails or the phone is offline
 * with nothing kept: the page's own states say those, a ticker would only repeat them.
 * </p>
 */
const SECONDS_PER_GAME = 8;

/** "Thu 1 Oct · 10:30–11:00" in the club's zone, to the time the game was sold to end. Kept here, not imported from the games lists, so My Code's first load stays light. */
function when(game: UpcomingGame, zone: string | undefined): string {
  const start = new Date(game.starts_at);
  return `${clubShortDate(start, zone)} · ${clubClock(start, zone)}–${clubClock(game.sold_ends_at ?? game.ends_at, zone)}`;
}

export function UpcomingTicker({ refreshKey, fallbackZone, className }: { refreshKey: unknown; fallbackZone?: string; className?: string }) {
  const { state } = useGamesRead(bookingsApi.upcoming, refreshKey, memberReads.upcoming.key);
  if (state.status !== "ready" || state.items.length === 0) return null;
  return <TickerLine games={state.items} zone={state.timezone ?? fallbackZone} className={className} />;
}

const PAUSED_KEY = "crusaders.ticker.paused";

/** The member's Pause, kept on this phone (a per-viewer convenience: storage may be absent). */
function usePausedChoice(): [boolean, (paused: boolean) => void] {
  const [paused, setPaused] = useState(() => {
    try { return localStorage.getItem(PAUSED_KEY) === "1"; } catch { return false; }
  });
  const choose = useCallback((next: boolean) => {
    setPaused(next);
    try { localStorage.setItem(PAUSED_KEY, next ? "1" : "0"); } catch { /* not kept: still paused now */ }
  }, []);
  return [paused, choose];
}

/** True when one run of the line is wider than the strip it scrolls in — re-measured as either resizes. */
function useOverflows(games: readonly UpcomingGame[]) {
  const strip = useRef<HTMLDivElement>(null);
  const run = useRef<HTMLUListElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const box = strip.current;
    const line = run.current;
    if (!box || !line) return;
    const measure = () => setOverflows(line.scrollWidth > box.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    watch.observe(line);
    return () => watch.disconnect();
  }, [games]);
  return { strip, run, overflows };
}

function TickerLine({ games, zone, className }: { games: readonly UpcomingGame[]; zone: string | undefined; className?: string }) {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [paused, setPaused] = usePausedChoice();
  const { strip, run, overflows } = useOverflows(games);
  const canMove = overflows && !reduced;
  const moving = canMove && !paused;
  const duration = `${Math.max(20, games.length * SECONDS_PER_GAME)}s`;
  return (
    <section
      aria-label={TICKER.label} data-upcoming-ticker="" data-moving={moving ? "" : undefined}
      className={cn("group flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border border-border bg-bg-surface pl-3 [&_:focus-visible]:-outline-offset-2", canMove ? "pr-1" : "pr-3", className)}
    >
      <span className="shrink-0 text-xs font-semibold uppercase tracking-wide text-text-secondary">{TICKER.label}</span>
      <div ref={strip} data-ticker-strip="" className="min-w-0 flex-1 overflow-x-auto group-data-[moving]:overflow-hidden [&_:focus-visible]:-outline-offset-2">
        <div
          style={{ ["--ticker-duration" as string]: duration }}
          className={cn("flex w-max", moving && "animate-ticker-scroll group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused]")}
        >
          <Run ref={run} games={games} zone={zone} />
          {moving ? <Run games={games} zone={zone} copy /> : null}
        </div>
      </div>
      {canMove ? (
        <IconButton label={paused ? TICKER.play : TICKER.pause} aria-pressed={paused} className="shrink-0" onClick={() => setPaused(!paused)}>
          {paused ? <Play weight="fill" aria-hidden="true" /> : <Pause weight="fill" aria-hidden="true" />}
        </IconButton>
      ) : null}
    </section>
  );
}

function Run({ games, zone, copy = false, ref }: { games: readonly UpcomingGame[]; zone: string | undefined; copy?: boolean; ref?: Ref<HTMLUListElement> }) {
  return (
    <ul ref={ref} className="flex shrink-0 items-center" aria-hidden={copy || undefined} {...(copy ? { inert: true } : {})}>
      {games.map((game) => (
        <li key={game.booking_id} className="shrink-0">
          <Link
            to={`/bookings/${game.booking_id}`} {...intentProps(`/bookings/${game.booking_id}`)} state={RESULT_READABLE}
            className="flex min-h-touch items-center gap-2 whitespace-nowrap px-3 text-sm tabular-nums text-text-primary"
          >
            <span className="font-semibold">{game.court_name}</span>
            <span className="text-text-secondary">{when(game, zone)}</span>
            {game.needs_action ? <span className="font-semibold text-warning-strong">· {TICKER.needsAction}</span> : null}
            <span aria-hidden="true" className="pl-3 text-text-muted">•</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
