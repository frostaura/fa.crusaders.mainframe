import { useState } from "react";
import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { useBalance } from "@/lib/balance";
import {
  playersEndpoints, type AddPlayersAnswer, type BookingDetail, type DetailPlayer, type PlayerSpec,
} from "@/lib/playersApi";
import { UnsureOutcome } from "@/lib/lostReply";
import { DETAIL_ACTIONS, firstName, PLAYERS_LOST, PLAYERS_UNSURE, playersRefusal } from "@/lib/playersCopy";
import { focusAfterAction } from "@/lib/focusAfterAction";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { addOrProve, orNotKnown, removeOrProve } from "./detailReadBack";
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

/** Who a pick is, in the sentences that name them. */
function pickName(pick: PickedPlayer): string {
  if (pick.kind === "member") return firstName(pick.name);
  if (pick.kind === "guest") return pick.name;
  return DETAIL_ACTIONS.newOpenSeat;
}

function addedSentence(pick: PickedPlayer): string {
  if (pick.kind === "member") return DETAIL_ACTIONS.invited(firstName(pick.name));
  if (pick.kind === "guest") return DETAIL_ACTIONS.guestAdded(pick.name);
  return DETAIL_ACTIONS.openSeatAdded;
}

/** An open seat found by a read-back: no token to show, so the share dialog makes a new link. */
function linkSeatToMake(answer: AddPlayersAnswer): ShareTarget | null {
  const seat = answer.participants[0];
  return seat ? { name: DETAIL_ACTIONS.openSeatName, participantId: seat.participant_id, path: null } : null;
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

  // R3 lost-reply audit — an add whose reply was lost is looked for on the booking.
  const invite = useAsyncAction(
    ({ pick, figure }: InviteRequest) => addOrProve(detail, pick, () => playersEndpoints.add(bookingId, { players: [specOf(pick, figure)] })),
    {
      success: ({ value, proven }, { pick }) => {
        say({ tone: "success", text: proven ? PLAYERS_LOST(addedSentence(pick)) : addedSentence(pick) });
        // A link seat found by the read-back has no link: its token was in the lost reply, so the
        // dialog offers to make one (path null) rather than showing nothing.
        if (pick.kind === "link") setSharing(proven ? linkSeatToMake(value) : newLinkSeat(value));
        reload();
      },
      failure: (error, { pick }) => {
        say({ tone: "danger", text: playersRefusal(error, { action: DETAIL_ACTIONS.inviteAction, unsure: PLAYERS_UNSURE.add(pickName(pick)) }) });
        if (error instanceof UnsureOutcome) reload();
      },
    },
  );

  const nudge = useAsyncAction(
    (p: DetailPlayer) => {
      setNudgingId(p.participant_id);
      // Nothing on the booking says a reminder went: a lost reply is said as not known.
      return orNotKnown(() => playersEndpoints.nudge(bookingId, p.participant_id ?? ""));
    },
    {
      success: (answer, p) => {
        say({ tone: "success", text: DETAIL_ACTIONS.nudged(seatName(p, detail.players), answer.nudges_left) });
        reload();
      },
      failure: (error, p) => {
        const name = seatName(p, detail.players);
        const unknown = error instanceof UnsureOutcome;
        say({ tone: unknown ? "info" : "danger", text: unknown ? PLAYERS_UNSURE.nudge(name) : playersRefusal(error, { action: DETAIL_ACTIONS.nudgeAction }) });
      },
    },
  );

  // R3 I-2 — a remove whose reply was lost is looked for on the booking before anything is said.
  const remove = useAsyncAction(
    (p: DetailPlayer) => removeOrProve(bookingId, p.participant_id ?? ""),
    {
      success: ({ proven }, p) => {
        setRemoving(null);
        const text = DETAIL_ACTIONS.removed(seatName(p, detail.players));
        say({ tone: "success", text: proven ? PLAYERS_LOST(text) : text });
        // R2 F2-12 — the dialog and the seat's Remove button are both gone: the Players heading
        // takes focus, never <body>.
        focusAfterAction(() => document.querySelector<HTMLElement>("[data-players-section] h2"));
        reload();
        void refresh();
      },
      failure: (error) => {
        // Unknown or not landed: the list behind the dialog is read again, and so is the wallet.
        if (error instanceof UnsureOutcome) { reload(); void refresh(); }
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
