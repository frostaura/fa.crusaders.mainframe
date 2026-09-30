import { useState } from "react";
import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BOOK_CONFIRM, BOOK_PLAYERS } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { inviteUrl, type BookingPlayers, type PlayersOutcome } from "./playersOutcome";
import { seatName } from "./playersDraft";
import type { PlayersStepState } from "./usePlayersStep";
import type { SelectedSlot } from "./types";
import { RESULT_READABLE } from "@/lib/bookingLink";

/**
 * The players on the Confirm step (who, and the one sentence saying who pays what) and on the
 * result (each open seat's invite link to share, the booking's own page, and a `players_error`
 * said plainly — the court stands even when the players could not be added).
 */

/* ─────────────────────────────── Confirm ─────────────────────────────── */

export function ConfirmPlayers({ players }: { players: PlayersStepState }) {
  const { draft, lines } = players;
  if (draft.seats.length === 0) return null;
  const names = draft.seats.map((s) => {
    if (s.player.kind === "guest") return BOOK_PLAYERS.guestShort(s.player.name);
    return s.player.kind === "link" ? BOOK_CONFIRM.linkInLine : seatName(s.player);
  });
  return (
    <section aria-label={BOOK_CONFIRM.playersLabel} data-confirm-players="" className="grid gap-2 rounded-xl border border-border bg-bg-surface p-4 text-sm">
      <p className="flex flex-wrap gap-x-2">
        <span className="font-semibold text-text-primary">{BOOK_CONFIRM.playersLabel}</span>
        <span className="text-text-secondary">{BOOK_CONFIRM.playersLine(names)}</span>
      </p>
      {lines === null ? (
        <div aria-busy="true" className="grid gap-1.5">
          <Skeleton className="h-4 w-full rounded-sm" />
          <Skeleton className="h-4 w-2/3 rounded-sm" />
        </div>
      ) : (
        lines.map((line) => <p key={line.price} data-confirm-sentence="" className="text-text-primary">{line.sentence}</p>)
      )}
    </section>
  );
}

/* ─────────────────────────────── the result ─────────────────────────────── */

type Face = (slot: SelectedSlot) => string;

type Shared = "shared" | "copied" | "cancelled";

/** Web Share where the phone has it; the clipboard where it does not, or where sharing failed. */
async function shareLink(url: string, text: string): Promise<Shared> {
  const nav = window.navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: BOOK_CONFIRM.shareTitle, text, url });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  await nav.clipboard.writeText(url);
  return "copied";
}

function ShareButton({ path, label, text }: { path: string; label: string; text: string }) {
  const url = inviteUrl(path);
  const [copied, setCopied] = useState(false);
  const action = useAsyncAction(() => shareLink(url, text), {
    success: (result) => setCopied(result === "copied"),
  });
  return (
    <div className="grid justify-items-start gap-1.5">
      <Button variant="secondary" pending={action.pending} onClick={() => void action.run()}>{label}</Button>
      <span role="status" className="text-sm text-text-secondary">
        {copied ? BOOK_CONFIRM.linkCopied : null}
        {action.status === "error" ? BOOK_CONFIRM.copyFailed(url) : null}
      </span>
    </div>
  );
}

function BookingBlock({ booking, face, titled }: { booking: BookingPlayers; face: Face; titled: boolean }) {
  const when = booking.slot ? face(booking.slot) : "";
  const text = booking.slot ? BOOK_CONFIRM.shareText(when, booking.slot.courtName) : BOOK_CONFIRM.shareTitle;
  return (
    <div className="grid gap-3" data-booking-players={booking.bookingId}>
      {titled && booking.slot ? (
        <p className="text-sm font-semibold text-text-primary">{`${booking.slot.courtName} · ${when}`}</p>
      ) : null}
      {booking.error ? <Alert tone="warning" live="polite">{BOOK_CONFIRM.playersError}</Alert> : null}
      {booking.links.map((link) => (
        <ShareButton
          key={link.seat} path={link.invitePath} text={text}
          label={booking.links.length > 1 ? BOOK_CONFIRM.shareLinkFor(link.seat) : BOOK_CONFIRM.shareLink}
        />
      ))}
      <Button asChild variant="outline" className="justify-self-start">
        <Link to={`/bookings/${booking.bookingId}`} state={RESULT_READABLE}>{BOOK_CONFIRM.seeBooking}</Link>
      </Button>
    </div>
  );
}

export function ResultPlayers({ outcome, face }: { outcome: PlayersOutcome; face: Face }) {
  if (outcome.bookings.length === 0) return null;
  const anyLinks = outcome.bookings.some((b) => b.links.length > 0);
  return (
    <section aria-label={BOOK_CONFIRM.playersLabel} data-result-players="" className="grid gap-4 rounded-xl border border-border bg-bg-surface p-4">
      {anyLinks ? <p className="text-sm text-text-secondary">{BOOK_CONFIRM.linksNote}</p> : null}
      {outcome.bookings.map((b) => (
        <BookingBlock key={b.bookingId} booking={b} face={face} titled={outcome.bookings.length > 1} />
      ))}
    </section>
  );
}
