import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, UserPlus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_COPY } from "@/lib/playersCopy";
import { formerPlayers, isCancelled, positions, seatName, statusTone, statusWord, type SeatPosition } from "./detailModel";

/**
 * The four seats, two a side: a photo, a first name and a status WORD on every chip (never colour
 * alone), a checked-in mark per seat, and whatever the viewer may do to that seat underneath.
 * The grid's rule holds here too — photo and first name, nothing else about another member.
 */
export type SeatActions = (player: DetailPlayer) => ReactNode;

type Props = { detail: BookingDetail; actions?: SeatActions };

export function PlayerChips({ detail, actions }: Props) {
  const former = formerPlayers(detail);
  const mine = detail.viewer.participant_id;
  const cancelled = isCancelled(detail);
  const teams = drawnTeams(detail);
  const lone = teams.length === 1;
  return (
    <div className="flex flex-col gap-6">
      {/* R8 L8-3 — `grid-cols-1`, not an implicit column: that one is floored at its longest word and
          pushed the page 15px sideways at 320 / 200 % (gotchas-frontend-layout). R14 L14-2 — two
          columns only while there are two teams to put in them. */}
      <div className={cn("grid grid-cols-1 gap-4", !lone && "sm:grid-cols-2")}>
        {teams.map((t) => (
          <Team key={t.label} label={t.label} seats={t.seats} lone={lone} mine={mine} actions={actions} cancelled={cancelled} players={detail.players} />
        ))}
      </div>
      {former.length > 0 ? <Former players={former} all={detail.players} actions={actions} /> : null}
    </div>
  );
}

/**
 * The teams worth drawing. R2 F2-9 — a cancelled game has no seat left to fill, and nor has one
 * that is over (R14 L14-2: completed, no-show): no dashed "Free seat" placeholders, and a team
 * nobody sat on is not drawn at all — its column was a 760px empty band beside Team A at 1920.
 */
function drawnTeams(detail: BookingDetail): { label: string; seats: SeatPosition[] }[] {
  const seats = positions(detail);
  const over = isCancelled(detail) || detail.status === "completed" || detail.status === "no_show";
  return [
    { label: DETAIL_COPY.teamA, seats: seats.slice(0, 2) },
    { label: DETAIL_COPY.teamB, seats: seats.slice(2, 4) },
  ]
    .map((t) => ({ ...t, seats: over ? t.seats.filter((s) => s.player) : t.seats }))
    .filter((t) => t.seats.length > 0);
}

type TeamProps = {
  label: string; seats: SeatPosition[]; lone: boolean; mine: string | null; actions?: SeatActions; cancelled: boolean;
  players: readonly DetailPlayer[];
};

function Team(props: TeamProps) {
  const { label, seats, lone, mine, actions, cancelled, players } = props;
  return (
    // A lone team takes the block's whole width, its chips two-up once its own box holds two
    // (32rem, so at 200 % text they stay one a row — gotchas-frontend-layout: rem queries are text queries).
    <div className={cn("flex flex-col gap-2", lone && "@container/team")}>
      <h3 className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{label}</h3>
      <ul className={cn("grid grid-cols-1 gap-2", lone && "@[32rem]/team:grid-cols-2")}>
        {seats.map((s) => (s.player
          ? <SeatChip key={s.seat} player={s.player} isMe={s.player.participant_id !== null && s.player.participant_id === mine} actions={actions} cancelled={cancelled} players={players} />
          : <FreeSeat key={s.seat} seat={s.seat} />))}
      </ul>
    </div>
  );
}

function FreeSeat({ seat }: { seat: number }) {
  return (
    <li data-seat={seat} data-free="" className="@container/seat flex min-h-touch items-center rounded-xl border border-dashed border-control p-3">
      <span className="flex min-w-0 flex-1 flex-col items-start gap-3 @[16rem]/seat:flex-row @[16rem]/seat:items-center">
        <span aria-hidden="true" className="size-10 shrink-0 rounded-full border border-dashed border-control" />
        <span className="grid min-w-0">
          <span className="text-sm font-semibold text-text-secondary">{DETAIL_COPY.freeSeat}</span>
          <span className="text-xs text-text-muted">{DETAIL_COPY.freeSeatHint}</span>
        </span>
      </span>
    </li>
  );
}

function SeatAvatar({ player, name }: { player: DetailPlayer; name: string }) {
  return (
    <Avatar size={40}>
      {player.photo_url ? <AvatarImage src={player.photo_url} alt="" /> : null}
      {player.kind === "open_link"
        ? <AvatarFallback><UserPlus size={20} aria-hidden="true" /></AvatarFallback>
        : <AvatarFallback name={name} />}
    </Avatar>
  );
}

type ChipProps = {
  player: DetailPlayer; isMe: boolean; actions?: SeatActions; cancelled?: boolean; players?: readonly DetailPlayer[];
};

function SeatChip({ player, isMe, actions, cancelled = false, players }: ChipProps) {
  const name = seatName(player, players);
  const shown = isMe ? DETAIL_COPY.you(name) : name;
  const word = statusWord(player, cancelled);
  const extra = actions?.(player);
  return (
    <li
      data-seat={player.seat}
      data-status={player.status}
      aria-label={DETAIL_COPY.seatLabel(shown, word)}
      className={cn("@container/seat flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-3", isMe && "border-accent-strong")}
    >
      {/* R9 L9-6 — when the text is large for the chip (under 16rem of its own width) the photo stands
          above the name: beside it, the column left over broke the status pill "Orga/niser". */}
      <div className="flex min-w-0 flex-col items-start gap-3 @[16rem]/seat:flex-row @[16rem]/seat:items-center">
        <SeatAvatar player={player} name={name} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="break-words text-sm font-semibold text-text-primary">{shown}</span>
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(player, cancelled)}>{word}</Badge>
            <CheckedIn at={player.checked_in_at} />
          </span>
        </div>
      </div>
      {extra ? <div className="flex flex-wrap items-center gap-2">{extra}</div> : null}
    </li>
  );
}

function CheckedIn({ at }: { at: string | null }) {
  if (!at) return <span className="sr-only">{DETAIL_COPY.notCheckedIn}</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-success-strong">
      <CheckCircle size={14} weight="bold" aria-hidden="true" className="shrink-0" />
      {DETAIL_COPY.checkedIn}
    </span>
  );
}

function Former({ players, all, actions }: { players: DetailPlayer[]; all: readonly DetailPlayer[]; actions?: SeatActions }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{DETAIL_COPY.formerTitle}</h3>
      <ul className="flex flex-col gap-2">
        {players.map((p) => (
          <SeatChip key={p.participant_id ?? `former-${p.seat}`} player={p} isMe={false} actions={actions} players={all} />
        ))}
      </ul>
    </div>
  );
}
