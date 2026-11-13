import { useCallback, useEffect, useRef, useState } from "react";
import { useBalance } from "@/lib/useBalance";
import { UnsureOutcome, outcomeUnknown } from "@/lib/bookingOutcome";
import { inviteMoney, payWhatYouCan, playersEndpoints, type AcceptAnswer, type Invite, type SeatAnswer } from "@/lib/playersApi";
import { INVITES_COPY } from "@/lib/playersCopy";
import { useAsyncAction, type AsyncAction } from "@/lib/useAsyncAction";
import { codeOf } from "./inviteFacts";
import { leaveOrProve } from "../detail/detailReadBack";
import { useUnreadCount } from "@/components/inbox/useUnreadCount";
import { answerReasonOf, provenBy, type Landed, type ProvenBy } from "@/lib/lostReply";

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
  /** `payMinutes` — pay what you can: the share the seat stands at after a part payment (omitted: the whole share). */
  accept: (expectedShareMinutes: number, payMinutes?: number) => Promise<AcceptAnswer>;
  /** Null when this seat cannot be declined (an open link seat — the server answers 404). */
  decline: (() => Promise<SeatAnswer>) | null;
  /** Read the invite again (after any answer). Never rejects. */
  reread: () => Promise<unknown>;
};

/**
 * `proven` — the accept's reply was lost and the seat's own record said "accepted" (R2 F2-1): the
 * figures are the ones the member was shown, and the wallet is being re-read. R19 — it says why the
 * reply was unsure (an error the club answered is not a reply that did not arrive).
 */
/** R15 J15-11 — `paidNow`: what this accept was asked to pay (the button's figure), beside the seat's total. */
/** Pay what you can — `rest`: on a part payment, what was left for the organiser to cover or split. */
export type AcceptOutcome =
  | { kind: "accepted"; answer: AcceptAnswer; proven?: ProvenBy; paidNow?: number; rest?: number }
  | { kind: "declined"; proven?: ProvenBy }
  | null;

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
  acceptAction: AsyncAction<[number, number | undefined], Accepted>;
  declineAction: AsyncAction<[], Landed<SeatAnswer>>;
  accept: () => void;
  /**
   * Pay what you can: on a sheet short of the share, the minutes this member can pay now — every
   * spendable minute — or null when there is no part to pay (not short, or nothing to spend).
   */
  partMinutes: number | null;
  /** Accepts paying {@link partMinutes} now; the organiser covers the rest until the others split it. */
  payPart: () => void;
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

  const acceptAction = useAsyncAction((expected: number, pay?: number) => acceptOrProve(port, invite, expected, pay), {
    success: (result, _expected, pay) => {
      // Pay what you can: this tap paid what the seat stands at less what it had paid; the rest went to the organiser.
      const already = invite.share_minutes - invite.to_pay_minutes;
      setOutcome(pay === undefined
        ? { kind: "accepted", answer: result.answer, proven: result.proven, paidNow: invite.to_pay_minutes }
        : { kind: "accepted", answer: result.answer, proven: result.proven, paidNow: pay - already, rest: invite.share_minutes - pay });
      void balance.refresh({ expectSelf: true });
      void port.reread();
      void refreshUnread();
    },
    failure: (failure) => {
      // A lost reply may have moved money either way: the wallet is read again whatever the seat said.
      if (failure instanceof UnsureOutcome) void balance.refresh({ expectSelf: true });
      // R8 X8-5 — a 402 is the club saying this phone's wallet is stale (somebody else moved it): read
      // it again, bare (not this member's doing), so the chip says what the sheet now does.
      else if (codeOf(failure) === "insufficient_balance" || codeOf(failure) === "share_affordable") void balance.refresh();
      void afterRefusal(failure);
    },
  });
  // R3 I-3 — a decline whose reply was lost is read back off the member's own seat.
  const declineAction = useAsyncAction(() => {
    const decline = port.decline;
    if (!decline) throw new Error("decline unavailable");
    return leaveOrProve(invite.participant_id, decline);
  }, {
    success: (landed) => { setOutcome({ kind: "declined", proven: provenBy(landed) }); void port.reread(); void refreshUnread(); },
    failure: (failure) => { void afterRefusal(failure); },
  });

  useRereadOnWalletMove(liveSpendable(balance), unanswered(outcome, acceptAction.pending, declineAction.pending), port);

  const money = inviteMoney(invite);
  const blocked: Blocked = rereading ? "rereading" : invite.cap ? "cap" : money.shortBy > 0 ? "short" : null;
  const part = blocked === "short" ? payWhatYouCan(invite.share_minutes, money.toPay, money.spendable) : null;
  // R9 X9-5 — a 402 the re-read explains (the sheet is now short) is said once, by the short
  // notice and its Buy minutes; the red refusal above it said the same thing a second time.
  const raw = acceptAction.error ?? declineAction.error;
  const error = codeOf(raw) === "insufficient_balance" && money.shortBy > 0 ? null : raw;
  const { run: runAccept } = acceptAction;
  const { run: runDecline } = declineAction;
  const accept = useCallback(() => {
    if (blocked) return;
    declineAction.reset();
    void runAccept(invite.share_minutes, undefined);
  }, [blocked, runAccept, invite.share_minutes, declineAction]);
  const payPart = useCallback(() => {
    if (part === null) return;
    declineAction.reset();
    void runAccept(invite.share_minutes, part);
  }, [part, runAccept, invite.share_minutes, declineAction]);
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
    acceptAction, declineAction, accept, decline, askingDecline,
    partMinutes: part === null ? null : part - (invite.share_minutes - money.toPay), payPart, confirmDecline, keepInvite, keptInvite,
    readingAgain: INVITES_COPY.readingAgain,
  };
}

/** The figure the chip shows: what may be spent, or the balance where nothing is held. */
function liveSpendable(balance: { held?: { spendable: number } | null; balance: number | null }): number | null {
  return balance.held?.spendable ?? balance.balance;
}

/** Nothing answered and nothing on its way: the only time a wallet move re-reads the invite. */
function unanswered(outcome: AcceptOutcome, accepting: boolean, declining: boolean): boolean {
  return outcome === null && !accepting && !declining;
}

/**
 * BM-09 — the invite's figures (balance now, balance after, short by) are the club's, read with the
 * invite. When the live wallet moves under an open invite (a club adjustment, a purchase, another
 * game's share) the invite is read again, so the pane never says "Balance now 1 h 30 min" beside a
 * chip that says 10 min. The first figure the wallet reports is the baseline, not a move; nothing is
 * re-read once this invite has been answered or while an answer is in flight (that path re-reads).
 */
function useRereadOnWalletMove(live: number | null, idle: boolean, port: AcceptPort) {
  const seen = useRef<number | null>(null);
  const { reread } = port;
  useEffect(() => {
    if (live === null) return;
    const before = seen.current;
    seen.current = live;
    if (before === null || before === live || !idle) return;
    void reread();
  }, [live, idle, reread]);
}

/** A yes: the server's own answer, or (`proven`) one read back off the seat after a lost reply. */
type Accepted = { answer: AcceptAnswer; proven: ProvenBy };

/**
 * R2 F2-1 — Accept, and when its reply is lost (5xx, timeout, dropped connection) the seat's own
 * record is read back (`GET /me/invites/{pid}`) and believed: accepted is a yes with the figures
 * the member was shown; anything else is an {@link UnsureOutcome} that says what was found. It
 * used to say "Couldn't accept" after the money had been taken.
 */
async function acceptOrProve(port: AcceptPort, invite: Invite, expected: number, pay?: number): Promise<Accepted> {
  try {
    return { answer: await port.accept(expected, pay), proven: false };
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
      share_minutes: seat.share_minutes, consented_minutes: seat.share_minutes,
      paid_minutes: pay === undefined ? invite.to_pay_minutes : pay - (invite.share_minutes - invite.to_pay_minutes),
      balance_minutes: invite.balance_minutes,
    };
    return { answer, proven: answerReasonOf(error) };
  }
}

/** The seat's routes — by seat id, as the invite mail and the list both know it. */
export function seatPort(invite: Pick<Invite, "booking_id" | "participant_id" | "open_link">, reread: () => Promise<unknown>): AcceptPort {
  return {
    accept: (expected, pay) => playersEndpoints.accept(invite.booking_id, invite.participant_id, expected, pay),
    decline: invite.open_link ? null : () => playersEndpoints.decline(invite.booking_id, invite.participant_id),
    reread,
  };
}
