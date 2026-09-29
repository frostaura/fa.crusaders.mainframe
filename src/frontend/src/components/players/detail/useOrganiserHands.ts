import { useState } from "react";
import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { useBalance } from "@/lib/balance";
import {
  playersEndpoints, type AddPlayersAnswer, type BookingDetail, type DetailPlayer, type PlayerSpec,
} from "@/lib/playersApi";
import { DETAIL_ACTIONS, firstName, playersRefusal } from "@/lib/playersCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { seatName } from "./detailModel";
import { needsShareAsk } from "./splitEditor";
import type { ShareTarget } from "./ShareLinkDialog";

/**
 * The organiser's hand on their own booking: invite, remind, hand on a seat's link, remove.
 * Every action runs through `useAsyncAction`, says what happened in one sentence — a refusal
 * through `playersRefusal`, never a code — and then re-reads the page.
 */
export type Notice = { tone: "success" | "danger" | "info"; text: string };

type Say = (notice: Notice) => void;

/** A figure the organiser named for the seat (R1 F2.1): an amount, or a ratio weight. */
type Figure = Pick<PlayerSpec, "weight" | "amount">;

type InviteRequest = { pick: PickedPlayer; figure?: Figure };

function specOf(pick: PickedPlayer, figure: Figure = {}): PlayerSpec {
  if (pick.kind === "member") return { userId: pick.userId, ...figure };
  if (pick.kind === "guest") return { guestName: pick.name };
  return { link: true, ...figure };
}

function addedSentence(pick: PickedPlayer): string {
  if (pick.kind === "member") return DETAIL_ACTIONS.invited(firstName(pick.name));
  if (pick.kind === "guest") return DETAIL_ACTIONS.guestAdded(pick.name);
  return DETAIL_ACTIONS.openSeatAdded;
}

/** The fresh open seat an add made — its token is shown this once. */
function newLinkSeat(answer: AddPlayersAnswer): ShareTarget | null {
  const seat = answer.participants.find((p) => p.invite_path && p.user_id === null && p.guest_name === null);
  return seat ? { name: DETAIL_ACTIONS.openSeatName, participantId: seat.participant_id, path: seat.invite_path } : null;
}

export function useOrganiserHands(detail: BookingDetail, reload: () => void, say: Say) {
  const bookingId = detail.booking_id;
  const { refresh } = useBalance();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<DetailPlayer | null>(null);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const [asking, setAsking] = useState<PickedPlayer | null>(null);
  const [changingSplit, setChangingSplit] = useState(false);

  const invite = useAsyncAction(
    ({ pick, figure }: InviteRequest) => playersEndpoints.add(bookingId, { players: [specOf(pick, figure)] }),
    {
      success: (answer, { pick }) => {
        say({ tone: "success", text: addedSentence(pick) });
        if (pick.kind === "link") setSharing(newLinkSeat(answer));
        reload();
      },
      failure: (error) => say({ tone: "danger", text: playersRefusal(error, { action: DETAIL_ACTIONS.inviteAction }) }),
    },
  );

  const nudge = useAsyncAction(
    (p: DetailPlayer) => {
      setNudgingId(p.participant_id);
      return playersEndpoints.nudge(bookingId, p.participant_id ?? "");
    },
    {
      success: (answer, p) => {
        say({ tone: "success", text: DETAIL_ACTIONS.nudged(seatName(p, detail.players), answer.nudges_left) });
        reload();
      },
      failure: (error) => say({ tone: "danger", text: playersRefusal(error, { action: DETAIL_ACTIONS.nudgeAction }) }),
    },
  );

  const remove = useAsyncAction(
    (p: DetailPlayer) => playersEndpoints.remove(bookingId, p.participant_id ?? ""),
    {
      success: (_answer, p) => {
        setRemoving(null);
        say({ tone: "success", text: DETAIL_ACTIONS.removed(seatName(p, detail.players)) });
        reload();
        void refresh();
      },
    },
  );

  return {
    detail,
    reload,
    inviting,
    openInvite: () => { setInviting(true); },
    closeInvite: () => setInviting(false),
    /** On an amount or ratio split a paying seat is asked its share first (R1 F2.1). */
    pick: (player: PickedPlayer) => {
      setInviting(false);
      if (needsShareAsk(detail, player)) setAsking(player);
      else void invite.run({ pick: player });
    },
    asking,
    ask: (player: PickedPlayer, figure: Figure) => { setAsking(null); void invite.run({ pick: player, figure }); },
    cancelAsk: () => setAsking(null),
    changingSplit,
    openSplit: () => setChangingSplit(true),
    closeSplit: () => setChangingSplit(false),
    splitDone: (notice: Notice) => { setChangingSplit(false); say(notice); reload(); },
    invitePending: invite.pending,
    nudge,
    isNudging: (p: DetailPlayer) => nudge.pending && nudgingId === p.participant_id,
    removing,
    askRemove: (p: DetailPlayer) => { remove.reset(); setRemoving(p); },
    cancelRemove: () => setRemoving(null),
    remove,
    sharing,
    share: (p: DetailPlayer) => setSharing({ name: seatName(p, detail.players), participantId: p.participant_id, path: null }),
    closeShare: () => setSharing(null),
  };
}

export type OrganiserHands = ReturnType<typeof useOrganiserHands>;
