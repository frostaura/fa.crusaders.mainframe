import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Envelope } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { StateBlock } from "@/components/ui/state-block";
import { Link } from "react-router-dom";
import { AcceptSheet } from "@/components/players/invites/AcceptSheet";
import { InviteDetail } from "@/components/players/invites/InviteDetail";
import { ContextBar } from "@/components/ui/context-bar";
import { SplitView } from "@/components/ui/split-view";
import { usePickParam, useSplitLayout } from "@/components/ui/use-split-layout";
import { InviteCard, InviteListSkeleton } from "@/components/players/invites/InviteCard";
import { useMyInvites } from "@/components/players/invites/useMyInvites";
import { usePendingLinkInvite } from "@/components/players/invites/usePendingLinkInvite";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { SPLIT_PANE_COPY } from "@/lib/inboxCopy";
import { inviteHeading } from "@/components/players/invites/inviteFacts";
import { useSheetHistory } from "@/lib/bookingSheetHistory";

/**
 * Invites (`/bookings/invites`) — the games friends have asked the member into, waiting for a
 * yes, asked again after a raise, or accepted with a share still to pay. Each card opens the
 * accept sheet; the list is read again after every answer.
 */
export default function InvitesPage() {
  const invites = useMyInvites();
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
          announce={picked.shown ? SPLIT_PANE_COPY.showing(inviteHeading(picked.shown, INVITES_COPY.sheetTitle).title) : undefined}
          list={(
            <ul aria-label={INVITES_COPY.listLabel} className="flex flex-col gap-3">
              {pending ? (
                <li key={`pending-${pending.token}`}>
                  <InviteCard invite={pending.invite} to={pending.path} note={INVITES_COPY.pendingFrom} />
                </li>
              ) : null}
              {items.map((invite) => (
                <li key={invite.participant_id}>
                  <InviteCard invite={invite} onOpen={wide ? picked.pick : sheet.openFor} current={wide && picked.invite?.participant_id === invite.participant_id} />
                </li>
              ))}
            </ul>
          )}
          detail={picked.shown ? <InviteDetail key={picked.shown.participant_id} invite={picked.shown} onReread={reread} /> : null}
          placeholder={<StateBlock empty emptyIcon={Envelope} emptyTitle={INVITES_COPY.pickTitle} emptyHint={INVITES_COPY.pickHint} />}
        />
      </StateBlock>
      {/* §4 wrong tap reach: with exactly one invite, its answer is docked in thumb reach. */}
      {only && !wide ? (
        <ContextBar position="bottom" until="lg" label={INVITES_COPY.actionsLabel}>
          <Button block onClick={() => sheet.openFor(only)}>{INVITES_COPY.answer}</Button>
        </ContextBar>
      ) : null}
      <AcceptSheet invite={sheet.invite} open={sheet.open} onOpenChange={sheet.setOpen} onReread={reread} session={sheet.session} onBusyChange={sheet.onBusyChange} />
    </PageShell>
  );
}

const SPLIT_AT = "56rem";

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
  const fromList = items?.find((i) => i.participant_id === seat) ?? (seat === null && wide && items?.length === 1 ? items[0] : null);
  const invite = fromList ?? (held && held.participant_id === seat ? held : null);
  if (fromList && fromList !== held) setHeld(fromList);
  const pick = useCallback((next: Invite) => pickSeat(next.participant_id), [pickSeat]);
  const shown = wide || seat !== null ? invite : null;
  return { invite, shown, pick, unpick };
}

function useSheet(items: Invite[] | null) {
  const [opened, setOpened] = useState<Invite | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const openFor = useCallback((invite: Invite) => {
    setOpened(invite);
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
  return { invite: latest, open, setOpen, openFor, session, onBusyChange };
}
