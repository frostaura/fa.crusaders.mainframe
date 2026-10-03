import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Envelope } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { StateBlock } from "@/components/ui/state-block";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { AcceptSheet } from "@/components/players/invites/AcceptSheet";
import { InviteDetail } from "@/components/players/invites/InviteDetail";
import { ContextBar } from "@/components/ui/context-bar";
import { SplitView } from "@/components/ui/split-view";
import { usePickParam, useSplitLayout } from "@/components/ui/use-split-layout";
import { InviteCard, InviteListSkeleton } from "@/components/players/invites/InviteCard";
import { useKeptInvites } from "@/lib/offline/useKeptInvites";
import { StaleNotice } from "@/components/shell/StaleNotice";
import { usePendingLinkInvite } from "@/components/players/invites/usePendingLinkInvite";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { SPLIT_PANE_COPY } from "@/lib/inboxCopy";
import { inviteHeading, organiserName } from "@/components/players/invites/inviteFacts";
import { useSheetHistory } from "@/lib/bookingSheetHistory";

/**
 * Invites (`/bookings/invites`) — the games friends have asked the member into, waiting for a
 * yes, asked again after a raise, or accepted with a share still to pay. Each card opens the
 * accept sheet; the list is read again after every answer.
 */
export default function InvitesPage() {
  // R5 M5-6 — kept by `lib/offline`: drawn at once on a revisit and from the phone offline.
  const invites = useKeptInvites();
  const sheet = useSheet(invites.items);
  // R1 F2.5 — a link the member opened and has not answered (an open seat is nobody's until it is
  // accepted, so the club's list cannot hold it): offered first, as a link back to it.
  const pending = usePendingLinkInvite(invites.items);
  const { refresh } = invites;
  const reread = useCallback(() => refresh(), [refresh]);
  // R4 form factor (SPEC 3.5): beside a pane a card opens its invite there (the URL keeps it:
  // `?seat=`); on a phone it opens the accept sheet, as it always has. R5 X5-3 — "beside a pane" is
  // the split view's own measure (its box, in rem), never the viewport.
  const layout = useSplitLayout(SPLIT_AT);
  const wide = layout.split;
  const picked = usePicked(invites.items, wide);
  const items = invites.items ?? [];
  const only = items.length === 1 && !pending ? items[0] : null;
  return (
    <PageShell width="wide">
      <PageHeader
        title={INVITES_COPY.title}
        description={INVITES_COPY.description}
        back={{ to: "/bookings", label: INVITES_COPY.back }}
        actions={<RefreshButton label={INVITES_COPY.refresh} onRefresh={() => void refresh()} loading={invites.loading} />}
        freshness={<Freshness at={invites.readAt} />}
      />
      <StaleNotice stale={invites.stale} readAt={invites.readAt} offline={invites.offline} />
      <StateBlock
        loading={invites.items === null && invites.loading}
        error={invites.items === null ? invites.error : null}
        action={INVITES_COPY.readAction}
        onRetry={() => void refresh()}
        empty={invites.items !== null && invites.items.length === 0 && !pending}
        emptyTitle={INVITES_COPY.emptyTitle}
        emptyHint={INVITES_COPY.emptyHint}
        emptyIcon={Envelope}
        emptyAction={(
          <Button asChild variant="outline">
            <Link to="/bookings">{INVITES_COPY.toBookings}</Link>
          </Button>
        )}
        skeleton={<InviteListSkeleton />}
      >
        <SplitView
          layout={layout}
          listLabel={INVITES_COPY.listLabel}
          splitAt={SPLIT_AT}
          back={{ label: SPLIT_PANE_COPY.backToInvites, onBack: picked.unpick }}
          pickedKey={picked.shown?.participant_id ?? null}
          announce={announceOf(picked.shown)}
          list={<InviteList items={items} pending={pending} wide={wide} picked={picked} openSheet={sheet.openFor} docked={dockedOf(only, wide) !== null} />}
          detail={picked.shown ? <InviteDetail key={picked.shown.participant_id} invite={picked.shown} onReread={reread} /> : null}
          placeholder={<StateBlock empty emptyIcon={Envelope} emptyTitle={INVITES_COPY.pickTitle} emptyHint={INVITES_COPY.pickHint} />}
        />
      </StateBlock>
      {/*
        §4 wrong tap reach: with exactly one invite, its answers are docked in thumb reach — and
        only there (R6 L6-13: the card's own Accept beside a docked "Answer this invite" was two
        primaries for one question). The card drops its answers while the dock carries them.
      */}
      <OneInviteDock invite={dockedOf(only, wide)} onAnswer={sheet.openFor} />
      <AcceptSheet
        invite={sheet.invite} open={sheet.open} onOpenChange={sheet.setOpen} onReread={reread}
        session={sheet.session} onBusyChange={sheet.onBusyChange} startWith={sheet.startWith}
      />
    </PageShell>
  );
}

const SPLIT_AT = "56rem";

/** The one invite whose answers are docked: exactly one, and the list stacked (a phone). */
function dockedOf(only: Invite | null, wide: boolean): Invite | null {
  return only && !wide ? only : null;
}

function OneInviteDock({ invite, onAnswer }: { invite: Invite | null; onAnswer: (invite: Invite, startWith?: "decline") => void }) {
  if (!invite) return null;
  return (
    <ContextBar position="bottom" until="lg" label={INVITES_COPY.actionsLabel}>
      <CardAnswers invite={invite} onAnswer={onAnswer} docked />
    </ContextBar>
  );
}

/**
 * §3.5 (R5) — on a phone (the list stacked) each card carries its answers. Accept opens the sheet,
 * where the share, the balance after and the cap are stated before anything is sent; Decline opens
 * it on "Decline for good?", focus on the safe answer. Decline only where the seat can be declined.
 */
function CardAnswers(props: { invite: Invite; onAnswer: (invite: Invite, startWith?: "decline") => void; docked?: boolean }) {
  const { invite, onAnswer, docked = false } = props;
  const declinable = invite.status === "invited" && !invite.open_link;
  // Docked, the two answers share the bar's width (Accept the wider), as a thumb reaches them.
  const grow = docked ? "flex-1" : undefined;
  return (
    <div role="group" aria-label={SPLIT_PANE_COPY.cardActionsLabel(organiserName(invite))} className={cn("flex flex-wrap justify-end gap-2", docked && "w-full")}>
      {declinable ? (
        <Button variant="outline" className={grow} onClick={() => onAnswer(invite, "decline")} data-card-decline="">{SPLIT_PANE_COPY.cardDecline}</Button>
      ) : null}
      <Button className={cn(grow, docked && "grow-[2]")} onClick={() => onAnswer(invite)} data-card-accept="">{SPLIT_PANE_COPY.cardAccept}</Button>
    </div>
  );
}

/**
 * The invite in the pane: `?seat=` when the member picked one, else — with exactly one waiting and
 * the list split — that one (SPEC 3.5: "with one invite, open it by default"). The last invite
 * shown is held while its answer lands, so "You're in" is not swapped for the placeholder when the
 * re-read drops it.
 *
 * <p>
 * `shown` is what the pane draws: beside the list, the pick or the default; stacked (a phone, or
 * 200 % text — R5 X5-3), only a pick the URL names, under the split view's back control, and never
 * the one-invite default, which would hide the list the member came to see.
 * </p>
 */
function usePicked(items: Invite[] | null, wide: boolean) {
  const { value: seat, pick: pickSeat, unpick } = usePickParam("seat");
  const [held, setHeld] = useState<Invite | null>(null);
  const fromList = pickedFrom(items, seat, wide);
  const invite = fromList ?? (held?.participant_id === seat ? held : null);
  if (fromList && fromList !== held) setHeld(fromList);
  const pick = useCallback((next: Invite) => pickSeat(next.participant_id), [pickSeat]);
  const shown = wide || seat !== null ? invite : null;
  return { invite, shown, pick, unpick };
}

type Picked = ReturnType<typeof usePicked>;

/** The named seat, or — beside the list, with nothing named and exactly one waiting — that one. */
function pickedFrom(items: Invite[] | null, seat: string | null, wide: boolean): Invite | null {
  if (!items) return null;
  if (seat !== null) return items.find((i) => i.participant_id === seat) ?? null;
  return wide && items.length === 1 ? items[0] : null;
}

function announceOf(shown: Invite | null): string | undefined {
  return shown ? SPLIT_PANE_COPY.showing(inviteHeading(shown, INVITES_COPY.sheetTitle).title) : undefined;
}

type ListProps = {
  items: Invite[];
  pending: ReturnType<typeof usePendingLinkInvite>;
  wide: boolean;
  picked: Picked;
  openSheet: (invite: Invite, startWith?: "decline") => void;
  /** R6 L6-13 — the one invite's answers are in the dock, so its card carries none. */
  docked: boolean;
};

/** The cards: beside a pane a card opens there; stacked it opens the sheet and carries its answers. */
function InviteList(props: ListProps) {
  const { items, pending, wide, picked, openSheet, docked } = props;
  return (
    <ul aria-label={INVITES_COPY.listLabel} className="flex flex-col gap-3">
      {pending ? (
        <li key={`pending-${pending.token}`}>
          <InviteCard invite={pending.invite} to={pending.path} note={INVITES_COPY.pendingFrom} />
        </li>
      ) : null}
      {items.map((invite) => (
        <li key={invite.participant_id}>
          <InviteCard
            invite={invite} onOpen={wide ? picked.pick : openSheet}
            current={wide && picked.invite?.participant_id === invite.participant_id}
            actions={wide || docked ? undefined : <CardAnswers invite={invite} onAnswer={openSheet} />}
          />
        </li>
      ))}
    </ul>
  );
}

function useSheet(items: Invite[] | null) {
  const [opened, setOpened] = useState<Invite | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const [startWith, setStartWith] = useState<"decline" | undefined>(undefined);
  const openFor = useCallback((invite: Invite, intent?: "decline") => {
    setOpened(invite);
    setStartWith(intent);
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  // R1 (F1.19's rule) — the phone's Back closes the sheet and stays on Invites; R4 — not while an
  // answer is on its way (the sheet's guard says so; the history entry goes back on).
  const busy = useRef(false);
  const close = useCallback(() => (busy.current ? false : setOpen(false)), []);
  const onBusyChange = useCallback((next: boolean) => { busy.current = next; }, []);
  useSheetHistory(open, close, "accept");
  const latest = opened ? items?.find((i) => i.participant_id === opened.participant_id) ?? opened : null;
  return { invite: latest, open, setOpen, openFor, session, onBusyChange, startWith };
}
