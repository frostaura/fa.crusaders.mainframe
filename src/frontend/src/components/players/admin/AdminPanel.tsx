import { Button } from "@/components/ui/button";
import { UserPlus } from "@/components/ui/icons";
import { Section } from "@/components/ui/page-shell";
import { MAX_SEATS } from "@/lib/playersApi";
import { DETAIL_ADMIN, playersWhen } from "@/lib/playersCopy";
import { liveCount } from "../detail/detailModel";
import { ShareLinkDialog } from "../detail/ShareLinkDialog";
import { AdminActDialog } from "./AdminActDialog";
import { AdminAddDialog } from "./AdminAddDialog";
import type { AdminHands } from "./useAdminHands";

/** Button icons, hoisted: 16px, decorative — the label names the action. */
const USERPLUS_ICON = <UserPlus aria-hidden="true" />;

/** The admin's own section: what god mode is, and "Add a player" while a seat is free. */
export function AdminSection({ hands }: { hands: AdminHands }) {
  const free = liveCount(hands.detail) < MAX_SEATS;
  return (
    <Section title={DETAIL_ADMIN.title} description={DETAIL_ADMIN.description}>
      {free ? (
        <div>
          <Button variant="outline" icon={USERPLUS_ICON} onClick={hands.openAdd}>{DETAIL_ADMIN.add}</Button>
        </div>
      ) : null}
    </Section>
  );
}

export function AdminDialogs({ hands }: { hands: AdminHands }) {
  const { detail } = hands;
  return (
    <>
      {hands.acting ? (
        <AdminActDialog
          key={`${hands.acting.act}:${hands.acting.player.participant_id}`}
          detail={detail}
          player={hands.acting.player}
          act={hands.acting.act}
          onClose={hands.closeAct}
          onDone={hands.actDone}
        />
      ) : null}
      {hands.adding ? <AdminAddDialog detail={detail} onClose={hands.closeAdd} onAdded={hands.added} /> : null}
      {hands.sharing ? (
        <ShareLinkDialog
          bookingId={detail.booking_id}
          target={hands.sharing}
          when={playersWhen(detail.starts_at)}
          onClose={hands.closeShare}
          onRotated={hands.reload}
        />
      ) : null}
    </>
  );
}
