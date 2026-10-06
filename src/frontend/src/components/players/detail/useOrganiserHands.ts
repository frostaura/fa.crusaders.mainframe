import { useReducer, useRef, useState } from "react";
import { useLateLanding } from "@/components/bookings/useSendingGuard";
import type { PickedPlayer } from "@/components/players/PlayerPicker";
import { useToast } from "@/components/toastContext";
import { useSheetHistory } from "@/lib/bookingSheetHistory";
import { useBalance } from "@/lib/useBalance";
import {
  playersEndpoints, type AddPlayersAnswer, type BookingDetail, type DetailPlayer, type PlayerSpec,
} from "@/lib/playersApi";
import { UnsureOutcome, unsureReasonOf } from "@/lib/lostReply";
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

/** The toast push when a provider is above us; null in a bare render. */
function useOptionalPush() {
  try {
    return useToast().push;
  } catch {
    return null;
  }
}

/**
 * R5 I5-2 — what the page says about a write, said where it can still be read: on the page while
 * the page is there, in a toast once it has gone (a forced route, a sign-out) — a landing is never
 * left to a notice that died with the page.
 */
function useTell(say: Say): Say {
  const late = useLateLanding();
  const push = useOptionalPush();
  return (notice: Notice) => {
    if (late.live()) say(notice);
    else push?.({ tone: notice.tone, text: notice.text });
  };
}

/**
 * R5 I5-2 — a dialog whose write may be in flight: the system Back closes it like the ×, but
 * while the write is on its way every way out is refused (the history entry goes back on) and
 * the dialog says again that it is waiting. `busy` is a ref so a Back a frame after the press is
 * refused too.
 */
function useGuardedDialog(open: boolean, close: () => void, tag: string) {
  const busy = useRef(false);
  const [refused, bumpRefused] = useReducer((n: number) => n + 1, 0);
  const tryClose = (): boolean => {
    if (busy.current) {
      bumpRefused();
      return false;
    }
    close();
    return true;
  };
  useSheetHistory(open, tryClose, tag);
  return { busy, refused, tryClose, setBusy: (next: boolean) => { busy.current = next; } };
}

export function useOrganiserHands(detail: BookingDetail, reload: () => void, pageSay: Say) {
  const bookingId = detail.booking_id;
  const say = useTell(pageSay);
  const { refresh } = useBalance();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<DetailPlayer | null>(null);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const [nudgingId, setNudgingId] = useState<string | null>(null);
  const [asking, setAsking] = useState<PickedPlayer | null>(null);
  const [changingSplit, setChangingSplit] = useState(false);
  const removeGuard = useGuardedDialog(removing !== null, () => setRemoving(null), "remove-player");
  const splitGuard = useGuardedDialog(changingSplit, () => setChangingSplit(false), "change-split");

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
        // R18 X18-1 / R19 X19-2 — a clash, a busy club and a plain 500 are answers, not silence.
        const words = unknown ? { busy: PLAYERS_UNSURE.nudgeBusy, conflict: PLAYERS_UNSURE.nudgeConflict, error: PLAYERS_UNSURE.nudgeError, silent: PLAYERS_UNSURE.nudge }[unsureReasonOf(error)] : PLAYERS_UNSURE.nudge;
        say({ tone: unknown ? "info" : "danger", text: unknown ? words(name) : playersRefusal(error, { action: DETAIL_ACTIONS.nudgeAction }) });
      },
    },
  );

  // R3 I-2 — a remove whose reply was lost is looked for on the booking before anything is said.
  const remove = useAsyncAction(
    (p: DetailPlayer) => removeOrProve(bookingId, p.participant_id ?? ""),
    {
      success: ({ proven }, p) => {
        removeGuard.setBusy(false); // answered: the close below is not a way out mid-flight
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
    /** Refused (false) while the save is on its way. */
    closeSplit: () => { splitGuard.tryClose(); },
    splitDone: (notice: Notice) => { splitGuard.setBusy(false); setChangingSplit(false); say(notice); reload(); },
    /** The split dialog reports its save in flight, so the system Back waits too (I5-2). */
    setSplitBusy: splitGuard.setBusy,
    splitRefused: splitGuard.refused,
    invitePending: invite.pending,
    nudge,
    isNudging: (p: DetailPlayer) => nudge.pending && nudgingId === p.participant_id,
    removing,
    askRemove: (p: DetailPlayer) => { remove.reset(); setRemoving(p); },
    /** Keep, the ×, Escape, the scrim — refused while the remove is on its way (I5-2). */
    cancelRemove: () => { removeGuard.tryClose(); },
    confirmRemove: (p: DetailPlayer) => {
      removeGuard.setBusy(true);
      void remove.run(p).finally(() => removeGuard.setBusy(false));
    },
    removeRefused: removeGuard.refused,
    remove,
    sharing,
    share: (p: DetailPlayer) => setSharing({ name: seatName(p, detail.players), participantId: p.participant_id, path: null }),
    closeShare: () => setSharing(null),
  };
}

export type OrganiserHands = ReturnType<typeof useOrganiserHands>;
