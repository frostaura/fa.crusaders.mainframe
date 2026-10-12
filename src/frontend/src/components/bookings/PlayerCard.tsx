import { useState, type ReactNode } from "react";
import { Minutes } from "@/components/Minutes";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CalendarBlank, Clock, MapPin } from "@/components/ui/icons";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { clubClock, clubShortDate } from "@/lib/clubClock";
import { PLAYER_CARD } from "@/lib/bookingsCopy";
import type { GridBooking } from "./types";

/**
 * Another member's booking, opened from the grid: who is on the court, large, and when.
 *
 * <p>
 * <b>Photo and first name only</b> — the grid's invariant (CLAUDE.md) holds on the card too: no
 * email, phone or membership number, and nothing the grid itself was not told (attendance and
 * the price stay private). The photo is what members recognise each other by, so it is the card.
 * </p>
 */
export function PlayerCard({ booking, onClose, now }: {
  booking: GridBooking | null;
  onClose: () => void;
  /** For tests — whether the game is on now. */
  now?: number;
}) {
  return (
    <Dialog open={booking !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {booking ? <CardBody booking={booking} now={now} /> : null}
    </Dialog>
  );
}

function CardBody({ booking, now: given }: { booking: GridBooking; now?: number }) {
  // Read once as the card opens (it mounts fresh on each opening).
  const [now] = useState(() => given ?? Date.now());
  const name = booking.memberFirstName ?? PLAYER_CARD.someone;
  const start = Date.parse(booking.startsAt);
  const end = Date.parse(booking.endsAt);
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  const playing = now >= start && now < end;
  const tz = booking.timezone;
  return (
    <DialogContent data-dialog="player-card">
      {/* No DialogHeader: its height cap (R4, for 200 % text) is for words, and the photo is the
          card. The whole card is the body, which scrolls when the text is large. */}
      <DialogBody className="flex flex-col items-center gap-4 pb-6 pt-6 text-center">
        <Avatar size={96} className="size-32 text-5xl shadow-md ring-4 ring-bg-surface" data-player-photo="">
          {booking.memberPhotoUrl ? <AvatarImage src={booking.memberPhotoUrl} alt="" /> : null}
          <AvatarFallback name={name} />
        </Avatar>
        <div className="flex flex-col items-center gap-1">
          <DialogTitle className="text-2xl">{name}</DialogTitle>
          <DialogDescription>{PLAYER_CARD.booked}</DialogDescription>
          {playing ? <Badge tone="success" className="mt-1" data-playing="">{PLAYER_CARD.onCourtBadge}</Badge> : null}
        </div>
        <dl className="grid w-full gap-3 rounded-xl border border-border bg-bg-surface p-4 text-left" data-player-card-facts="">
          <Fact icon={<MapPin size={20} aria-hidden="true" />} label={PLAYER_CARD.court}>{booking.courtName}</Fact>
          <Fact icon={<CalendarBlank size={20} aria-hidden="true" />} label={PLAYER_CARD.day}>
            {clubShortDate(booking.startsAt, tz, { weekday: true })}
          </Fact>
          <Fact icon={<Clock size={20} aria-hidden="true" />} label={PLAYER_CARD.time}>
            <span className="tabular-nums">{`${clubClock(booking.startsAt, tz)}–${clubClock(booking.endsAt, tz)}`}</span>
            <span className="text-text-secondary"> · <Minutes value={minutes} /></span>
          </Fact>
        </dl>
      </DialogBody>
    </DialogContent>
  );
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0 text-text-muted">{icon}</span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <dt className="text-xs font-medium text-text-muted">{label}</dt>
        <dd className="min-w-0 break-words text-sm font-medium text-text-primary">{children}</dd>
      </div>
    </div>
  );
}
