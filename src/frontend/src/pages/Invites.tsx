import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Envelope } from "@/components/ui/icons";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { Freshness, RefreshButton } from "@/components/ui/refresh-button";
import { StateBlock } from "@/components/ui/state-block";
import { Link } from "react-router-dom";
import { AcceptSheet } from "@/components/players/invites/AcceptSheet";
import { InviteCard, InviteListSkeleton } from "@/components/players/invites/InviteCard";
import { useMyInvites } from "@/components/players/invites/useMyInvites";
import type { Invite } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";

/**
 * Invites (`/bookings/invites`) — the games friends have asked the member into, waiting for a
 * yes, asked again after a raise, or accepted with a share still to pay. Each card opens the
 * accept sheet; the list is read again after every answer.
 */
export default function InvitesPage() {
  const invites = useMyInvites();
  const sheet = useSheet(invites.items);
  const { refresh } = invites;
  const reread = useCallback(() => refresh(), [refresh]);
  return (
    <PageShell width="narrow">
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
        empty={invites.items !== null && invites.items.length === 0}
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
        <ul aria-label={INVITES_COPY.listLabel} className="flex flex-col gap-3">
          {(invites.items ?? []).map((invite) => (
            <li key={invite.participant_id}>
              <InviteCard invite={invite} onOpen={sheet.openFor} />
            </li>
          ))}
        </ul>
      </StateBlock>
      <AcceptSheet invite={sheet.invite} open={sheet.open} onOpenChange={sheet.setOpen} onReread={reread} session={sheet.session} />
    </PageShell>
  );
}

/**
 * Which invite the sheet shows. The latest read of that seat when the list still has it, else
 * the row it was opened with — an accept that went through takes the seat off the list, and the
 * sheet must go on showing its confirmation rather than going blank.
 */
function useSheet(items: Invite[] | null) {
  const [opened, setOpened] = useState<Invite | null>(null);
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  const openFor = useCallback((invite: Invite) => {
    setOpened(invite);
    setSession((n) => n + 1);
    setOpen(true);
  }, []);
  const latest = opened ? items?.find((i) => i.participant_id === opened.participant_id) ?? opened : null;
  return { invite: latest, open, setOpen, openFor, session };
}
