import { useId, useState, type ReactNode } from "react";
import { intentProps } from "@/routeChunks";
import { Link } from "react-router-dom";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Interactable } from "@/components/ui/interactable";
import { CaretRight, Warning } from "@/components/ui/icons";
import { UPCOMING } from "@/lib/bookingsCopy";
import { bookingsApi, type UpcomingGame, type UpcomingPlayer } from "@/lib/bookingsApi";
import { firstName } from "@/lib/playersCopy";
import { memberReads } from "@/lib/offline/memberReads";
import { useGamesRead } from "./useGamesRead";
import { GAMES_ITEM, GAMES_LIST, SHOWN, when } from "./gameWhen";
import { RESULT_READABLE } from "@/lib/bookingLink";

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

export function UpcomingGames({ refreshKey, fallbackZone }: { refreshKey: unknown; fallbackZone?: string }) {
  const { state, retry } = useGamesRead(bookingsApi.upcoming, refreshKey, memberReads.upcoming.key);
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
      <ul className={GAMES_LIST}>
        {shown.map((game) => <li key={game.booking_id} className={GAMES_ITEM}><GameCard game={game} zone={zone} /></li>)}
      </ul>
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" className="justify-self-start" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? UPCOMING.less : UPCOMING.more(hidden)}
        </Button>
      ) : null}
    </section>
  );
}

/** One game, opening its booking page. `badges` replace the role badge's neighbours (R2 F1-1). */
export function GameCard({ game, zone, badges }: { game: UpcomingGame; zone: string | undefined; badges?: ReactNode }) {
  const time = when(game, zone);
  return (
    <Interactable asChild surface="card" watermark>
      <Link
        to={`/bookings/${game.booking_id}`}
        {...intentProps(`/bookings/${game.booking_id}`)}
        state={RESULT_READABLE}
        className="flex min-h-touch items-center gap-3 rounded-xl border border-border bg-bg-surface p-3 text-left shadow-xs"
      >
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm font-semibold text-text-primary">{game.court_name}</span>
            <Badge tone={game.role === "partner" ? "info" : "brand"}>{game.role === "partner" ? UPCOMING.partner : UPCOMING.organiser}</Badge>
            {badges ?? (game.needs_action ? <Badge tone="warning">{UPCOMING.needsAction}</Badge> : null)}
          </span>
          <span className="text-sm tabular-nums text-text-secondary">{time}</span>
          {/* R4 form factor: in the phone's sideways strip the card is court, time and what it
              needs, ~72px tall, so the grid starts on the first screen; the faces and the money
              are a tap away on the booking's page, and on the card wherever the rail is wider. */}
          <span className="hidden min-w-0 flex-col gap-1 @[40rem]/aside:flex">
            <GamePeople players={game.players} />
            {/* R3 V-9: its own line, never "· your share" trailing the names — at 320 the share
                wrapped and the separator dangled at the start of the line. */}
            <MoneyLine game={game} />
          </span>
        </span>
        <CaretRight size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
      </Link>
    </Interactable>
  );
}

/**
 * R3 M-3 — what the game has cost the member: owed on their seat, else paid off their wallet.
 * "Your share 25.00" was said to an organiser who had paid 50 while the partner never accepted.
 * A server without the figures (or a game that has cost nothing yet) keeps the share line.
 */
function MoneyLine({ game }: { game: UpcomingGame }) {
  const owing = game.my_owing_credits ?? 0;
  const paid = game.my_paid_credits ?? 0;
  let text: string | null = null;
  if (owing > 0) text = UPCOMING.owe(owing);
  else if (paid > 0) text = UPCOMING.paid(paid);
  else if (game.my_share_credits !== null) text = UPCOMING.share(game.my_share_credits);
  return text ? <span className="text-xs tabular-nums text-text-secondary">{text}</span> : null;
}

/**
 * Who is playing: faces and first names of the ACCEPTED seats only (R3 M-3 — a partner who never
 * said yes was listed as playing), and a count of the invites still out. A seat with no name —
 * an invite link nobody has claimed — is never split or initialled (R3 V-1: it crashed the page).
 */
function GamePeople({ players }: { players: readonly UpcomingPlayer[] }) {
  const playing = players.filter((p): p is UpcomingPlayer & { name: string } => p.status === "accepted" && Boolean(p.name?.trim()));
  const waiting = players.filter((p) => p.status === "invited").length;
  const faces = playing.slice(0, 3);
  if (faces.length === 0 && waiting === 0) return null;
  return (
    // R2 F1-10: wraps rather than truncating.
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
      {faces.length ? (
        // R2 F1-8: two pixels of overlap, which the ring covers — "VV" read "V\" when the
        // next face sat six pixels over it.
        <span aria-hidden="true" className="flex -space-x-0.5">
          {faces.map((p, i) => (
            <Avatar key={`${p.name}-${i}`} size={24} className="ring-2 ring-bg-surface">
              {p.photo_url ? <AvatarImage src={p.photo_url} alt="" /> : null}
              <AvatarFallback name={p.name} />
            </Avatar>
          ))}
        </span>
      ) : null}
      <span className="min-w-0 break-words">{UPCOMING.people(faces.map((p) => firstName(p.name)), waiting)}</span>
    </span>
  );
}
