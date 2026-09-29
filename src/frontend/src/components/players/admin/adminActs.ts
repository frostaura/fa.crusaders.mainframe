import { playersEndpoints } from "@/lib/playersApi";
import { DETAIL_ADMIN } from "@/lib/playersCopy";
import { formatCredits } from "@/lib/utils";
import type { AdminAct } from "../detail/detailModel";

/**
 * God mode on one seat, as data: what each act is called, what it says before it happens, the
 * call it makes, and the sentence after. The dialog is one component for all four; only this
 * table differs.
 */
export type ActRequest = { bookingId: string; participantId: string; reason: string; allowNegativeBalance: boolean };

export type ActSpec = {
  label: string;
  title: (name: string) => string;
  body: string;
  confirm: string;
  /** Collect ALWAYS asks for the overdraft go-ahead; remove and settle ask when the server does. */
  alwaysOverdraft: boolean;
  /** The server may answer `overdraft_not_authorised` and want the go-ahead. */
  mayOverdraft: boolean;
  tone: "danger" | "primary";
  call: (req: ActRequest) => Promise<unknown>;
  /** The sentence after. `organiser` is the organiser's first name, for a return that waits on them. */
  done: (name: string, answer: unknown, organiser: string) => string;
};

/**
 * P11 — a remove or settle-outside whose return could not be paid: the organiser's balance could
 * not cover it, so no money has moved. Null when the return went through (or the API predates it).
 */
function waitingReturn(answer: unknown): { amount: string | null } | null {
  const a = answer as { return_waiting?: unknown; return_credits?: unknown } | null;
  if (a?.return_waiting !== true) return null;
  return { amount: typeof a.return_credits === "number" ? formatCredits(a.return_credits) : null };
}

function collectedOf(answer: unknown): number {
  const value = (answer as { collected_credits?: unknown } | null)?.collected_credits;
  return typeof value === "number" ? value : 0;
}

export const ACTS: Record<AdminAct, ActSpec> = {
  remove: {
    label: DETAIL_ADMIN.remove, title: DETAIL_ADMIN.removeTitle, body: DETAIL_ADMIN.removeBody, confirm: DETAIL_ADMIN.removeConfirm,
    alwaysOverdraft: false, mayOverdraft: true, tone: "danger",
    call: (r) => playersEndpoints.adminRemove(r.bookingId, r.participantId, r.reason, r.allowNegativeBalance),
    done: (name, answer, organiser) => {
      const waiting = waitingReturn(answer);
      return waiting ? DETAIL_ADMIN.removedWaiting(name, waiting.amount, organiser) : DETAIL_ADMIN.removed(name);
    },
  },
  accept: {
    label: DETAIL_ADMIN.accept, title: DETAIL_ADMIN.acceptTitle, body: DETAIL_ADMIN.acceptBody, confirm: DETAIL_ADMIN.acceptConfirm,
    alwaysOverdraft: false, mayOverdraft: false, tone: "primary",
    call: (r) => playersEndpoints.adminAccept(r.bookingId, r.participantId, r.reason),
    done: (name) => DETAIL_ADMIN.accepted(name),
  },
  settle: {
    label: DETAIL_ADMIN.settle, title: DETAIL_ADMIN.settleTitle, body: DETAIL_ADMIN.settleBody, confirm: DETAIL_ADMIN.settleConfirm,
    alwaysOverdraft: false, mayOverdraft: true, tone: "primary",
    call: (r) => playersEndpoints.adminSettleOutside(r.bookingId, r.participantId, r.reason, r.allowNegativeBalance),
    done: (name, answer, organiser) => {
      const waiting = waitingReturn(answer);
      return waiting ? DETAIL_ADMIN.settledWaiting(name, waiting.amount, organiser) : DETAIL_ADMIN.settled(name);
    },
  },
  collect: {
    label: DETAIL_ADMIN.collect, title: DETAIL_ADMIN.collectTitle, body: DETAIL_ADMIN.collectBody, confirm: DETAIL_ADMIN.collectConfirm,
    alwaysOverdraft: true, mayOverdraft: true, tone: "primary",
    call: (r) => playersEndpoints.adminCollect(r.bookingId, r.participantId, r.reason),
    done: (name, answer) => DETAIL_ADMIN.collected(name, formatCredits(collectedOf(answer))),
  },
};

/** The go-ahead's sentence: who may go below zero, and — for a collect — by taking how much. */
export function overdraftSentence(act: AdminAct, seatName: string, amount: number, organiserName: string): string {
  return act === "collect"
    ? DETAIL_ADMIN.overdraftCollect(formatCredits(amount), seatName)
    : DETAIL_ADMIN.overdraftReturn(organiserName);
}

