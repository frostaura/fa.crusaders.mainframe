import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Interactable } from "@/components/ui/interactable";
import { CaretRight, Warning } from "@/components/ui/icons";
import { clubClock } from "@/lib/clubClock";
import { UPCOMING } from "@/lib/bookingsCopy";
import { bookingsApi, type UpcomingGame } from "@/lib/bookingsApi";
import { clubDayLabel } from "./bookFlow";

/**
 * F1.12 — the member's upcoming games, above the grid (contract §2): every future game they
 * booked or hold an accepted partner's seat on, soonest first, each opening its booking page.
 *
 * <p>
 * A partner's game was on no screen of theirs: the grid drew it as somebody else's court and the
 * booking page was reachable only from an email. This list is where both kinds of game live.
 * </p>
 *
 * <p>
 * <b>Quiet when there is nothing, honest when it fails.</b> No games draws nothing — the grid is
 * the page's business and a "no games" card would push it down a phone for no reason. A failed
 * read is said in one line with a retry, never drawn as "no games".
 * </p>
 */
const SHOWN = 3;

type State =
  | { status: "loading" }
  | { status: "ready"; items: UpcomingGame[]; timezone: string | undefined }
  | { status: "error" };

function useUpcoming(refreshKey: unknown) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; state: State } | null>(null);
  const key = `${String(refreshKey)}|${attempt}`;
  useEffect(() => {
    let live = true;
    bookingsApi.upcoming().then(
      (res) => { if (live) setAnswer({ key, state: { status: "ready", items: res.items ?? [], timezone: res.timezone } }); },
      () => { if (live) setAnswer({ key, state: { status: "error" } }); },
    );
    return () => { live = false; };
  }, [key]);
  // A re-read keeps the list it had rather than flashing empty under a member's thumb.
  const state: State = answer ? answer.state : { status: "loading" };
  return { state, retry: () => setAttempt((n) => n + 1) };
}

export function UpcomingGames({ refreshKey, fallbackZone }: { refreshKey: unknown; fallbackZone?: string }) {
  const { state, retry } = useUpcoming(refreshKey);
  const [all, setAll] = useState(false);
  const headingId = useId();
  if (state.status === "loading") return null;
  if (state.status === "error") {
    return (
      <div data-upcoming="" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary">
        <Warning size={16} weight="bold" aria-hidden="true" className="shrink-0 text-warning-strong" />
        <span>{UPCOMING.failed}</span>
        <Button variant="ghost" size="sm" onClick={retry}>{UPCOMING.retry}</Button>
      </div>
    );
  }
  if (state.items.length === 0) return null;
  const zone = state.timezone ?? fallbackZone;
  const shown = all ? state.items : state.items.slice(0, SHOWN);
  const hidden = state.items.length - SHOWN;
  return (
    <section aria-labelledby={headingId} data-upcoming="" className="grid gap-2">
      <h2 id={headingId} className="text-sm font-semibold text-text-primary">{UPCOMING.title}</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((game) => <li key={game.booking_id}><GameCard game={game} zone={zone} /></li>)}
      </ul>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? UPCOMING.less : UPCOMING.more(hidden)}
        </Button>
      ) : null}
    </section>
  );
}

function when(game: UpcomingGame, zone: string | undefined): string {
  const start = new Date(game.starts_at);
  return `${clubDayLabel(start, zone)} · ${clubClock(start, zone)}–${clubClock(game.ends_at, zone)}`;
}

function GameCard({ game, zone }: { game: UpcomingGame; zone: string | undefined }) {
  const time = when(game, zone);
  const others = game.players.slice(0, 3);
  return (
    <Interactable asChild surface="card" watermark>
      <Link
        to={`/bookings/${game.booking_id}`}
        className="flex min-h-touch items-center gap-3 rounded-xl border border-border bg-bg-surface p-3 text-left shadow-xs"
      >
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm font-semibold text-text-primary">{game.court_name}</span>
            <Badge tone={game.role === "partner" ? "info" : "brand"}>{game.role === "partner" ? UPCOMING.partner : UPCOMING.organiser}</Badge>
            {game.needs_action ? <Badge tone="warning">{UPCOMING.needsAction}</Badge> : null}
          </span>
          <span className="text-sm tabular-nums text-text-secondary">{time}</span>
          {others.length || game.my_share_credits !== null ? (
            // R2 F1-10: wraps rather than truncating — at twice the text size the share, the one
            // figure on the card, was cut off. The amount itself never breaks.
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
              {others.length ? (
                // R2 F1-8: two pixels of overlap, which the ring covers — "VV" read "V\" when the
                // next face sat six pixels over it.
                <span aria-hidden="true" className="flex -space-x-0.5">
                  {others.map((p) => (
                    <Avatar key={`${p.name}-${p.status}`} size={24} className="ring-2 ring-bg-surface">
                      {p.photo_url ? <AvatarImage src={p.photo_url} alt="" /> : null}
                      <AvatarFallback name={p.name} />
                    </Avatar>
                  ))}
                </span>
              ) : null}
              {others.length ? <span className="min-w-0 break-words">{others.map((p) => p.name.split(/\s+/)[0]).join(", ")}</span> : null}
              {game.my_share_credits !== null ? (
                <span className="whitespace-nowrap">{others.length ? "· " : ""}{UPCOMING.share(game.my_share_credits)}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        <CaretRight size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
      </Link>
    </Interactable>
  );
}
