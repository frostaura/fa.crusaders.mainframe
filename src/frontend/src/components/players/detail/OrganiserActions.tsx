import { Alert } from "@/components/Alert";
import { SendingNote } from "@/components/bookings/SheetParts";
import { PlayerPickerDialog } from "@/components/players/PlayerPicker";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Bell, ShareNetwork, SlidersHorizontal, UserMinus, UserPlus } from "@/components/ui/icons";
import { MAX_SEATS, type DetailPlayer } from "@/lib/playersApi";
import { CHANGE_SPLIT, DETAIL_ACTIONS, PLAYERS_UNSURE, playersRefusal, playersWhen } from "@/lib/playersCopy";
import { ChangeSplitDialog } from "./ChangeSplitDialog";
import { canNudge, canRemove, canShareLink, isCancelled, isLive, liveCount, seatName } from "./detailModel";
import { ShareAskDialog } from "./ShareAskDialog";
import { ShareLinkDialog } from "./ShareLinkDialog";
import type { OrganiserHands } from "./useOrganiserHands";

/** Button icons, hoisted: 16px, decorative — the label names the action. */
const BELL_ICON = <Bell aria-hidden="true" />;
const SHARE_ICON = <ShareNetwork aria-hidden="true" />;
const USERMINUS_ICON = <UserMinus aria-hidden="true" />;
const USERPLUS_ICON = <UserPlus aria-hidden="true" />;
const SPLIT_ICON = <SlidersHorizontal aria-hidden="true" />;

/**
 * What the organiser can do to one seat, as buttons under its chip: Remind, Share link, Remove.
 * Each is named for the player it acts on, so a screen reader walking four chips of buttons
 * hears "Remind Alex", not four "Remind"s. Full 44 px targets (R2 F2-15): the small size drew
 * 36 px buttons side by side on a phone.
 */
export function OrganiserSeatButtons({ player, hands }: { player: DetailPlayer; hands: OrganiserHands }) {
  const name = seatName(player, hands.detail.players);
  return (
    <>
      {canNudge(player) ? (
        <Button
          variant="secondary" icon={BELL_ICON}
          aria-label={DETAIL_ACTIONS.nudgeFor(name)}
          pending={hands.isNudging(player)}
          onClick={() => void hands.nudge.run(player)}
        >
          {DETAIL_ACTIONS.nudge}
        </Button>
      ) : null}
      {canShareLink(player) ? (
        <Button variant="outline" icon={SHARE_ICON} aria-label={DETAIL_ACTIONS.linkFor(name)} onClick={() => hands.share(player)}>
          {DETAIL_ACTIONS.link}
        </Button>
      ) : null}
      {canRemove(player) ? (
        <Button variant="danger-soft" icon={USERMINUS_ICON} aria-label={DETAIL_ACTIONS.removeFor(name)} onClick={() => hands.askRemove(player)}>
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

/**
 * "Change split" (R1 F2.1) — the organiser's, while the server allows it and somebody besides
 * them is paying a share. A booking of guests alone has nothing to split.
 */
export function ChangeSplitButton({ hands }: { hands: OrganiserHands }) {
  const { detail } = hands;
  const paying = detail.players.some((p) => isLive(p) && (p.kind === "member" || p.kind === "open_link"));
  if (!detail.permissions.can_change_split || !paying || isCancelled(detail)) return null;
  return <Button variant="outline" icon={SPLIT_ICON} onClick={hands.openSplit}>{CHANGE_SPLIT.open}</Button>;
}

/** The organiser's dialogs: the picker, the share ask, the split, the remove confirm, and the link. One open at a time. */
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
      {hands.asking ? <ShareAskDialog detail={detail} pick={hands.asking} onCancel={hands.cancelAsk} onAsk={hands.ask} /> : null}
      {hands.changingSplit ? (
        <ChangeSplitDialog
          detail={detail} onClose={hands.closeSplit} onDone={hands.splitDone} onStale={hands.reload}
          onBusyChange={hands.setSplitBusy} refused={hands.splitRefused}
        />
      ) : null}
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
  const name = seatName(player, hands.detail.players);
  const open = player.kind === "open_link";
  const error = hands.remove.error;
  const busy = hands.remove.pending;
  return (
    // R5 I5-2 — every way out (Keep, ×, Escape, scrim, the system Back) waits while the remove is
    // on its way; the footer says so in place of Keep.
    <Dialog open onOpenChange={(next) => { if (!next) hands.cancelRemove(); }}>
      <DialogContent data-dialog="remove-player">
        <DialogHeader>
          <DialogTitle>{open ? DETAIL_ACTIONS.removeOpenTitle : DETAIL_ACTIONS.removeTitle(name)}</DialogTitle>
          {/* R7 J7-9 — what the remove does to money: what goes back to them (paid, net of any
              share already returned), and that the organiser now carries their share — a remove
              never re-splits. */}
          <DialogDescription>
            {open ? DETAIL_ACTIONS.removeOpenBody : DETAIL_ACTIONS.removeBodyFor(name, { paid: player.paid_minutes ?? 0, share: player.share_minutes ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <DialogBody>
            <Alert tone="danger">{playersRefusal(error, { action: DETAIL_ACTIONS.removeAction, unsure: PLAYERS_UNSURE.remove(name) })}</Alert>
          </DialogBody>
        ) : null}
        <DialogFooter>
          <SendingNote text={busy ? DETAIL_ACTIONS.removeSending : null} refused={hands.removeRefused} />
          {busy ? null : <Button variant="outline" onClick={hands.cancelRemove}>{DETAIL_ACTIONS.removeKeep}</Button>}
          <Button variant="danger" pending={busy} onClick={() => hands.confirmRemove(player)}>
            {DETAIL_ACTIONS.removeConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
