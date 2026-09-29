import { useCallback, useState } from "react";
import { useBalance } from "@/lib/balance";
import { inviteMoney, playersEndpoints, type AcceptAnswer, type Invite, type SeatAnswer } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { useAsyncAction, type AsyncAction } from "@/lib/useAsyncAction";
import { codeOf } from "./inviteFacts";

/**
 * One invite's accept / decline, shared by the sheet (Invites page) and the link page.
 *
 * <p>
 * <b>Consent is to the figure shown.</b> Accept sends `expectedShareCredits = share_credits` —
 * the server compares it with the seat's current share (`PlayersService.Member.cs`,
 * `seat.ShareCredits > expected` → `409 share_changed`). A risen share is never retried for the
 * member: the invite is read again, the new figure is shown with the reason, and Accept waits
 * for a fresh tap on the new label.
 * </p>
 */
export type AcceptPort = {
  accept: (expectedShareCredits: number) => Promise<AcceptAnswer>;
  /** Null when this seat cannot be declined (an open link seat — the server answers 404). */
  decline: (() => Promise<SeatAnswer>) | null;
  /** Read the invite again (after any answer). Never rejects. */
  reread: () => Promise<unknown>;
};

export type AcceptOutcome = { kind: "accepted"; answer: AcceptAnswer } | { kind: "declined" } | null;

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
  acceptAction: AsyncAction<[number], AcceptAnswer>;
  declineAction: AsyncAction<[], SeatAnswer>;
  accept: () => void;
  /** The first tap: asks whether to decline for good (R1 F2.6). Nothing is sent. */
  decline: () => void;
  /** Declining is final, so it waits for this second, explicit tap. */
  askingDecline: boolean;
  confirmDecline: () => void;
  keepInvite: () => void;
  /** The sentence while Accept is waiting on a re-read. */
  readingAgain: string;
};

export function useAcceptFlow(invite: Invite, port: AcceptPort): AcceptFlow {
  const balance = useBalance();
  const [outcome, setOutcome] = useState<AcceptOutcome>(null);
  const [rereading, setRereading] = useState(false);
  const [askingDecline, setAskingDecline] = useState(false);

  const afterRefusal = useCallback(async (failure: unknown) => {
    // Only the API's own answers mean the invite moved; a dropped connection changed nothing.
    if (codeOf(failure) === null) return;
    setRereading(true);
    try { await port.reread(); } finally { setRereading(false); }
  }, [port]);

  const acceptAction = useAsyncAction((expected: number) => port.accept(expected), {
    success: (answer) => {
      setOutcome({ kind: "accepted", answer });
      void balance.refresh({ expectSelf: true });
      void port.reread();
    },
    failure: (failure) => { void afterRefusal(failure); },
  });
  const declineAction = useAsyncAction(() => {
    if (!port.decline) throw new Error("decline unavailable");
    return port.decline();
  }, {
    success: () => { setOutcome({ kind: "declined" }); void port.reread(); },
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
    void runAccept(invite.share_credits);
  }, [blocked, runAccept, invite.share_credits, declineAction]);
  const decline = useCallback(() => {
    acceptAction.reset();
    setAskingDecline(true);
  }, [acceptAction]);
  const confirmDecline = useCallback(() => {
    setAskingDecline(false);
    void runDecline();
  }, [runDecline]);
  const keepInvite = useCallback(() => setAskingDecline(false), []);

  return {
    invite, money, blocked, outcome, error, errorCode: codeOf(error),
    canDecline: Boolean(port.decline) && invite.status === "invited" && !invite.open_link,
    acceptAction, declineAction, accept, decline, askingDecline, confirmDecline, keepInvite,
    readingAgain: INVITES_COPY.readingAgain,
  };
}

/** The seat's routes — by seat id, as the invite mail and the list both know it. */
export function seatPort(invite: Pick<Invite, "booking_id" | "participant_id" | "open_link">, reread: () => Promise<unknown>): AcceptPort {
  return {
    accept: (expected) => playersEndpoints.accept(invite.booking_id, invite.participant_id, expected),
    decline: invite.open_link ? null : () => playersEndpoints.decline(invite.booking_id, invite.participant_id),
    reread,
  };
}
