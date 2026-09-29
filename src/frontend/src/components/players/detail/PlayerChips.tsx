import type { ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, UserPlus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { BookingDetail, DetailPlayer } from "@/lib/playersApi";
import { DETAIL_COPY } from "@/lib/playersCopy";
import { formerPlayers, positions, seatName, statusTone, statusWord, type SeatPosition } from "./detailModel";

/**
 * The four seats, two a side: a photo, a first name and a status WORD on every chip (never colour
 * alone), a checked-in mark per seat, and whatever the viewer may do to that seat underneath.
 * The grid's rule holds here too — photo and first name, nothing else about another member.
 */
export type SeatActions = (player: DetailPlayer) => ReactNode;

type Props = { detail: BookingDetail; actions?: SeatActions };

export function PlayerChips({ detail, actions }: Props) {
  const seats = positions(detail);
  const former = formerPlayers(detail);
  const mine = detail.viewer.participant_id;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Team label={DETAIL_COPY.teamA} seats={seats.slice(0, 2)} mine={mine} actions={actions} />
        <Team label={DETAIL_COPY.teamB} seats={seats.slice(2, 4)} mine={mine} actions={actions} />
      </div>
      {former.length > 0 ? <Former players={former} actions={actions} /> : null}
    </div>
  );
}

function Team({ label, seats, mine, actions }: { label: string; seats: SeatPosition[]; mine: string | null; actions?: SeatActions }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{label}</h3>
      <ul className="flex flex-col gap-2">
        {seats.map((s) => (s.player
          ? <SeatChip key={s.seat} player={s.player} isMe={s.player.participant_id !== null && s.player.participant_id === mine} actions={actions} />
          : <FreeSeat key={s.seat} seat={s.seat} />))}
      </ul>
    </div>
  );
}

function FreeSeat({ seat }: { seat: number }) {
  return (
    <li data-seat={seat} data-free="" className="flex min-h-touch items-center gap-3 rounded-xl border border-dashed border-control p-3">
      <span aria-hidden="true" className="size-10 shrink-0 rounded-full border border-dashed border-control" />
      <span className="grid min-w-0">
        <span className="text-sm font-semibold text-text-secondary">{DETAIL_COPY.freeSeat}</span>
        <span className="text-xs text-text-muted">{DETAIL_COPY.freeSeatHint}</span>
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

function SeatChip({ player, isMe, actions }: { player: DetailPlayer; isMe: boolean; actions?: SeatActions }) {
  const name = seatName(player);
  const shown = isMe ? DETAIL_COPY.you(name) : name;
  const word = statusWord(player);
  const extra = actions?.(player);
  return (
    <li
      data-seat={player.seat}
      data-status={player.status}
      aria-label={DETAIL_COPY.seatLabel(shown, word)}
      className={cn("flex flex-col gap-3 rounded-xl border border-border bg-bg-surface p-3", isMe && "border-accent-strong")}
    >
      <div className="flex min-w-0 items-center gap-3">
        <SeatAvatar player={player} name={name} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="break-words text-sm font-semibold text-text-primary">{shown}</span>
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(player)}>{word}</Badge>
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
      <CheckCircle size={14} weight="bold" aria-hidden="true" />
      {DETAIL_COPY.checkedIn}
    </span>
  );
}

function Former({ players, actions }: { players: DetailPlayer[]; actions?: SeatActions }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{DETAIL_COPY.formerTitle}</h3>
      <ul className="flex flex-col gap-2">
        {players.map((p) => (
          <SeatChip key={p.participant_id ?? `former-${p.seat}`} player={p} isMe={false} actions={actions} />
        ))}
      </ul>
    </div>
  );
}
