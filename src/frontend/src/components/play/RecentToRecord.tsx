import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { bookingsApi, recentAction, type RecentGame, type RecentGames } from "@/lib/bookingsApi";
import { playWhen, RESULTS_PAGE } from "@/lib/playCopy";
import { useRead } from "@/lib/useRead";

/**
 * R2 F2-17 — "Record a result on a booking you've played" used to be a sentence with no way to
 * do it: a finished game was reachable only by remembering its day on the grid. My results now
 * lists the recent games (contract C3, F1's `bookingsApi.recent` and `recentAction` — one reader
 * of the endpoint) that ask something of the viewer, each opening its booking with the record or
 * confirm sheet already up (`?result=record|confirm`).
 *
 * <p>
 * Three states, never collapsed: a skeleton while reading, a failure with its retry, and — when
 * nothing is waiting — no section at all, because the page's own empty state already says how a
 * result gets here.
 * </p>
 */
const load = () => bookingsApi.recent();

export function RecentToRecord() {
  const [read, retry] = useRead<RecentGames>("recent-games", load);
  const waiting = (read.data?.items ?? []).filter((g) => recentAction(g) !== null);
  if (read.data && waiting.length === 0) return null;
  return (
    <Section title={RESULTS_PAGE.toRecordTitle} description={RESULTS_PAGE.toRecordDescription} data-to-record="">
      <StateBlock
        loading={read.loading}
        error={read.error}
        action={RESULTS_PAGE.toRecordAction}
        onRetry={retry}
        skeleton={<Skeleton className="h-16 rounded-xl" />}
      >
        <ul aria-label={RESULTS_PAGE.toRecordLabel} className="flex flex-col gap-2">
          {waiting.map((game) => <GameRow key={game.booking_id} game={game} timezone={read.data?.timezone} />)}
        </ul>
      </StateBlock>
    </Section>
  );
}

function GameRow({ game, timezone }: { game: RecentGame; timezone?: string }) {
  const action = recentAction(game);
  const name = RESULTS_PAGE.row(game.court_name, playWhen(game.starts_at, timezone));
  const to = `/bookings/${encodeURIComponent(game.booking_id)}?result=${action === "confirm" ? "confirm" : "record"}`;
  return (
    <li data-to-record-row={action ?? ""} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-bg-surface p-3">
      <span className="min-w-0 break-words text-sm font-medium text-text-primary">{name}</span>
      <Button asChild variant={action === "confirm" ? "primary" : "outline"}>
        <Link to={to} aria-label={action === "confirm" ? RESULTS_PAGE.confirmFor(name) : RESULTS_PAGE.recordFor(name)}>
          {action === "confirm" ? RESULTS_PAGE.confirm : RESULTS_PAGE.record}
        </Link>
      </Button>
    </li>
  );
}
