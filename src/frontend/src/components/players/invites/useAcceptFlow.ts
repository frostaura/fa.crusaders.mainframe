import { useCallback, useState } from "react";
import { useBalance } from "@/lib/balance";
import { UnsureOutcome, outcomeUnknown } from "@/lib/bookingOutcome";
import { inviteMoney, playersEndpoints, type AcceptAnswer, type Invite, type SeatAnswer } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { useAsyncAction, type AsyncAction } from "@/lib/useAsyncAction";
import { codeOf } from "./inviteFacts";
import { leaveOrProve } from "../detail/detailReadBack";
import { useUnreadCount } from "@/components/inbox/useUnreadCount";
import type { Landed } from "@/lib/lostReply";

/**
 * One invite's accept / decline, shared by the sheet (Invites page) and the link page.
 *
 * <p>
 * <b>Consent is to the figure shown.</b> Accept sends `expectedShareMinutes = share_minutes` —
 * the server compares it with the seat's current share (`PlayersService.Member.cs`,
 * `seat.ShareMinutes > expected` → `409 share_changed`). A risen share is never retried for the
 * member: the invite is read again, the new figure is shown with the reason, and Accept waits
 * for a fresh tap on the new label.
 * </p>
 */
export type AcceptPort = {
  accept: (expectedShareMinutes: number) => Promise<AcceptAnswer>;
  /** Null when this seat cannot be declined (an open link seat — the server answers 404). */
  decline: (() => Promise<SeatAnswer>) | null;
  /** Read the invite again (after any answer). Never rejects. */
  reread: () => Promise<unknown>;
};

/**
 * `proven` — the accept's reply was lost and the seat's own record said "accepted" (R2 F2-1): the
 * figures are the ones the member was shown, and the wallet is being re-read.
 */
export type AcceptOutcome = { kind: "accepted"; answer: AcceptAnswer; proven?: boolean } | { kind: "declined"; proven?: boolean } | null;

/** Why Accept cannot be pressed, most pressing first — or null when it can. */
export type Blocked = "rereading" | "cap" | "short" | null;

export type AcceptFlow = {
  invite: Invite;
  money: ReturnType<typeof inviteMoney>;
  blocked: Blocked;
  canDecline: boolean;
  outcome: AcceptOutcome;
  /** The last refusal or failure, from either action. */
  error: unknown;
  errorCode: string | null;
  acceptAction: AsyncAction<[number], Accepted>;
  declineAction: AsyncAction<[], Landed<SeatAnswer>>;
  accept: () => void;
  /** The first tap: asks whether to decline for good (R1 F2.6). Nothing is sent. */
  decline: () => void;
  /** Declining is final, so it waits for this second, explicit tap. */
  askingDecline: boolean;
  confirmDecline: () => void;
  keepInvite: () => void;
  /** True once "Keep the invite" was pressed, until Decline is pressed again — where focus returns. */
  keptInvite: boolean;
  /** The sentence while Accept is waiting on a re-read. */
  readingAgain: string;
};

export function useAcceptFlow(invite: Invite, port: AcceptPort): AcceptFlow {
  const balance = useBalance();
  // R3 I-9 — answering an invite marks its notice read on the server: the bell reads the count again.
  const { refresh: refreshUnread } = useUnreadCount();
  const [outcome, setOutcome] = useState<AcceptOutcome>(null);
  const [rereading, setRereading] = useState(false);
  const [askingDecline, setAskingDecline] = useState(false);
  const [keptInvite, setKeptInvite] = useState(false);

  const afterRefusal = useCallback(async (failure: unknown) => {
    // Only the API's own answers mean the invite moved — or a lost reply that was read back.
    if (codeOf(failure) === null && !(failure instanceof UnsureOutcome)) return;
    setRereading(true);
    try { await port.reread(); } finally { setRereading(false); }
  }, [port]);

  const acceptAction = useAsyncAction((expected: number) => acceptOrProve(port, invite, expected), {
    success: (result) => {
      setOutcome({ kind: "accepted", answer: result.answer, proven: result.proven });
      void balance.refresh({ expectSelf: true });
      void port.reread();
      void refreshUnread();
    },
    failure: (failure) => {
      // A lost reply may have moved money either way: the wallet is read again whatever the seat said.
      if (failure instanceof UnsureOutcome) void balance.refresh({ expectSelf: true });
      // R8 X8-5 — a 402 is the club saying this phone's wallet is stale (somebody else moved it): read
      // it again, bare (not this member's doing), so the chip says what the sheet now does.
      else if (codeOf(failure) === "insufficient_balance") void balance.refresh();
      void afterRefusal(failure);
    },
  });
  // R3 I-3 — a decline whose reply was lost is read back off the member's own seat.
  const declineAction = useAsyncAction(() => {
    const decline = port.decline;
    if (!decline) throw new Error("decline unavailable");
    return leaveOrProve(invite.participant_id, decline);
  }, {
    success: ({ proven }) => { setOutcome({ kind: "declined", proven }); void port.reread(); void refreshUnread(); },
    failure: (failure) => { void afterRefusal(failure); },
  });

  const money = inviteMoney(invite);
  const blocked: Blocked = rereading ? "rereading" : invite.cap ? "cap" : money.shortBy > 0 ? "short" : null;
  const error = acceptAction.error ?? declineAction.error;
  const { run: runAccept } = acceptAction;
  const { run: runDecline } = declineAction;
  const accept = useCallback(() => {
    if (blocked) return;
    declineAction.reset();
    void runAccept(invite.share_minutes);
  }, [blocked, runAccept, invite.share_minutes, declineAction]);
  const decline = useCallback(() => {
    acceptAction.reset();
    setKeptInvite(false);
    setAskingDecline(true);
  }, [acceptAction]);
  const confirmDecline = useCallback(() => {
    setAskingDecline(false);
    void runDecline();
  }, [runDecline]);
  const keepInvite = useCallback(() => { setKeptInvite(true); setAskingDecline(false); }, []);

  return {
    invite, money, blocked, outcome, error, errorCode: codeOf(error),
    canDecline: Boolean(port.decline) && invite.status === "invited" && !invite.open_link,
    acceptAction, declineAction, accept, decline, askingDecline, confirmDecline, keepInvite, keptInvite,
    readingAgain: INVITES_COPY.readingAgain,
  };
}

/** A yes: the server's own answer, or (`proven`) one read back off the seat after a lost reply. */
type Accepted = { answer: AcceptAnswer; proven: boolean };

/**
 * R2 F2-1 — Accept, and when its reply is lost (5xx, timeout, dropped connection) the seat's own
 * record is read back (`GET /me/invites/{pid}`) and believed: accepted is a yes with the figures
 * the member was shown; anything else is an {@link UnsureOutcome} that says what was found. It
 * used to say "Couldn't accept" after the money had been taken.
 */
async function acceptOrProve(port: AcceptPort, invite: Invite, expected: number): Promise<Accepted> {
  try {
    return { answer: await port.accept(expected), proven: false };
  } catch (error) {
    if (!outcomeUnknown(error)) throw error;
    let seat;
    try {
      seat = await playersEndpoints.mySeat(invite.participant_id);
    } catch {
      throw new UnsureOutcome(error, false);
    }
    if (seat.status !== "accepted" || seat.lapsed || seat.booking_status === "cancelled") throw new UnsureOutcome(error, true);
    const answer: AcceptAnswer = {
      participant_id: seat.participant_id, booking_id: seat.booking_id, status: seat.status,
      share_minutes: seat.share_minutes, consented_minutes: seat.share_minutes, paid_minutes: invite.to_pay_minutes,
      balance_minutes: invite.balance_minutes,
    };
    return { answer, proven: true };
  }
}

/** The seat's routes — by seat id, as the invite mail and the list both know it. */
export function seatPort(invite: Pick<Invite, "booking_id" | "participant_id" | "open_link">, reread: () => Promise<unknown>): AcceptPort {
  return {
    accept: (expected) => playersEndpoints.accept(invite.booking_id, invite.participant_id, expected),
    decline: invite.open_link ? null : () => playersEndpoints.decline(invite.booking_id, invite.participant_id),
    reread,
  };
}
