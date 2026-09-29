import { Alert } from "@/components/Alert";
import { PlayerPickerDialog } from "@/components/players/PlayerPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Bell, ShareNetwork, UserMinus, UserPlus } from "@/components/ui/icons";
import { MAX_SEATS, type DetailPlayer } from "@/lib/playersApi";
import { DETAIL_ACTIONS, playersRefusal, playersWhen } from "@/lib/playersCopy";
import { canNudge, canRemove, canShareLink, liveCount, seatName } from "./detailModel";
import { ShareLinkDialog } from "./ShareLinkDialog";
import type { OrganiserHands } from "./useOrganiserHands";

/** Button icons, hoisted: 16px, decorative — the label names the action. */
const BELL_ICON = <Bell aria-hidden="true" />;
const SHARE_ICON = <ShareNetwork aria-hidden="true" />;
const USERMINUS_ICON = <UserMinus aria-hidden="true" />;
const USERPLUS_ICON = <UserPlus aria-hidden="true" />;

/**
 * What the organiser can do to one seat, as buttons under its chip: Remind, Share link, Remove.
 * Each is named for the player it acts on, so a screen reader walking four chips of buttons
 * hears "Remind Alex", not four "Remind"s.
 */
export function OrganiserSeatButtons({ player, hands }: { player: DetailPlayer; hands: OrganiserHands }) {
  const name = seatName(player);
  return (
    <>
      {canNudge(player) ? (
        <Button
          size="sm" variant="secondary" icon={BELL_ICON}
          aria-label={DETAIL_ACTIONS.nudgeFor(name)}
          pending={hands.isNudging(player)}
          onClick={() => void hands.nudge.run(player)}
        >
          {DETAIL_ACTIONS.nudge}
        </Button>
      ) : null}
      {canShareLink(player) ? (
        <Button size="sm" variant="outline" icon={SHARE_ICON} aria-label={DETAIL_ACTIONS.linkFor(name)} onClick={() => hands.share(player)}>
          {DETAIL_ACTIONS.link}
        </Button>
      ) : null}
      {canRemove(player) ? (
        <Button size="sm" variant="danger-soft" icon={USERMINUS_ICON} aria-label={DETAIL_ACTIONS.removeFor(name)} onClick={() => hands.askRemove(player)}>
          {DETAIL_ACTIONS.remove}
        </Button>
      ) : null}
    </>
  );
}

/** "Invite a player" — shown while a seat is free. */
export function InviteButton({ hands }: { hands: OrganiserHands }) {
  if (liveCount(hands.detail) >= MAX_SEATS) return null;
  return (
    <Button variant="secondary" icon={USERPLUS_ICON} pending={hands.invitePending} onClick={hands.openInvite}>
      {DETAIL_ACTIONS.invite}
    </Button>
  );
}

/** The organiser's dialogs: the picker, the remove confirm, and the link. One open at a time. */
export function OrganiserDialogs({ hands }: { hands: OrganiserHands }) {
  const { detail } = hands;
  const exclude = detail.players.filter((p) => p.user_id).map((p) => p.user_id as string);
  return (
    <>
      <PlayerPickerDialog
        open={hands.inviting}
        onOpenChange={(open) => { if (!open) hands.closeInvite(); }}
        title={DETAIL_ACTIONS.inviteTitle}
        excludeUserIds={exclude}
        onPick={hands.pick}
      />
      {hands.removing ? <RemoveDialog hands={hands} player={hands.removing} /> : null}
      {hands.sharing ? (
        <ShareLinkDialog
          key={`${hands.sharing.participantId}:${hands.sharing.path ?? "new"}`}
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

function RemoveDialog({ hands, player }: { hands: OrganiserHands; player: DetailPlayer }) {
  const name = seatName(player);
  const open = player.kind === "open_link";
  const error = hands.remove.error;
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !hands.remove.pending) hands.cancelRemove(); }}>
      <DialogContent data-dialog="remove-player">
        <DialogHeader>
          <DialogTitle>{open ? DETAIL_ACTIONS.removeOpenTitle : DETAIL_ACTIONS.removeTitle(name)}</DialogTitle>
          <DialogDescription>{open ? DETAIL_ACTIONS.removeOpenBody : DETAIL_ACTIONS.removeBody(name)}</DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogBody>
            <Alert tone="danger">{playersRefusal(error, { action: DETAIL_ACTIONS.removeAction })}</Alert>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={hands.cancelRemove}>{DETAIL_ACTIONS.removeKeep}</Button>
          <Button variant="danger" pending={hands.remove.pending} onClick={() => void hands.remove.run(player)}>
            {DETAIL_ACTIONS.removeConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
