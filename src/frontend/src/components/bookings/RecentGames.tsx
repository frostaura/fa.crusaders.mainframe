import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Warning } from "@/components/ui/icons";
import { RECENT, UPCOMING } from "@/lib/bookingsCopy";
import { bookingsApi, recentAction, type RecentGame } from "@/lib/bookingsApi";
import { GameCard } from "./UpcomingGames";
import { SHOWN, when } from "./gameWhen";
import { useGamesRead } from "./useGamesRead";

/**
 * R2 F1-1 — the games that finished within the result window (contract C3), under the upcoming
 * ones, each opening its booking page; a game whose result the viewer can record, or must
 * confirm, carries that action as its own link to the result sheet (`?result=record|confirm`).
 *
 * <p>
 * A finished game used to be on no screen at all — gone from Upcoming, drawn on the grid as a
 * dead "Past" cell — so the result it existed to hold could be recorded only from an email.
 * Quiet when there is none; a failed read is said in one line with a retry.
 * </p>
 */
export function RecentGames({ refreshKey, fallbackZone }: { refreshKey: unknown; fallbackZone?: string }) {
  const { state, retry } = useGamesRead<RecentGame>(bookingsApi.recent, refreshKey);
  const [all, setAll] = useState(false);
  const headingId = useId();
  if (state.status === "loading") return null;
  if (state.status === "error") {
    return (
      <div data-recent="" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
        <Warning size={16} weight="bold" aria-hidden="true" className="shrink-0 text-warning-strong" />
        <span>{RECENT.failed}</span>
        <Button variant="ghost" size="sm" onClick={retry}>{RECENT.retry}</Button>
      </div>
    );
  }
  if (state.items.length === 0) return null;
  const zone = state.timezone ?? fallbackZone;
  const shown = all ? state.items : state.items.slice(0, SHOWN);
  const hidden = state.items.length - SHOWN;
  return (
    <section aria-labelledby={headingId} data-recent="" className="grid gap-2">
      <h2 id={headingId} className="text-sm font-semibold text-text-primary">{RECENT.title}</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((game) => <li key={game.booking_id} className="grid gap-1.5"><RecentCard game={game} zone={zone} /></li>)}
      </ul>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? RECENT.less : RECENT.more(hidden)}
        </Button>
      ) : null}
    </section>
  );
}

const STATUS_BADGE = {
  pending: { tone: "info", text: RECENT.pending },
  confirmed: { tone: "success", text: RECENT.confirmed },
  disputed: { tone: "warning", text: RECENT.disputed },
} as const;

const NEEDS_YOU = { tone: "warning", text: UPCOMING.needsAction } as const;

function RecentCard({ game, zone }: { game: RecentGame; zone: string | undefined }) {
  const action = recentAction(game);
  // The side asked to confirm is told it is waiting on THEM, not "waiting for a confirm".
  const badge = action === "confirm" ? NEEDS_YOU : game.result_status === "none" ? null : STATUS_BADGE[game.result_status];
  const time = when(game, zone);
  return (
    <>
      <GameCard game={game} zone={zone} badges={badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : null} />
      {action ? (
        <Button asChild variant={action === "confirm" ? "primary" : "outline"} className="justify-self-stretch sm:justify-self-start">
          <Link
            to={`/bookings/${game.booking_id}?result=${action}`}
            aria-label={action === "record" ? RECENT.recordFor(game.court_name, time) : RECENT.confirmFor(game.court_name, time)}
          >
            {action === "record" ? RECENT.record : RECENT.confirm}
          </Link>
        </Button>
      ) : null}
    </>
  );
}
