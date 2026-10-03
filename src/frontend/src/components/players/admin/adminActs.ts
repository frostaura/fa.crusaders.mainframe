import { ApiError } from "@/lib/api";
import { playersEndpoints, type BookingDetail, type DetailPlayer } from "@/lib/playersApi";
import { DETAIL_ADMIN } from "@/lib/playersCopy";
import { minutesSpoken } from "@/lib/minutes";
import { collectable, type AdminAct } from "../detail/detailModel";

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
  /**
   * R3 lost-reply audit — did this act land, judged off the seat read back (undefined: gone)?
   * Returns the answer to word it with, or null when the seat shows it did not.
   */
  landed: (was: DetailPlayer, now: DetailPlayer | undefined) => unknown;
};

/**
 * P11 — a remove or settle-outside whose return could not be paid: the organiser's balance could
 * not cover it, so no money has moved. Null when the return went through (or the API predates it).
 */
function waitingReturn(answer: unknown): { amount: string | null } | null {
  const a = answer as { return_waiting?: unknown; return_minutes?: unknown } | null;
  if (a?.return_waiting !== true) return null;
  return { amount: typeof a.return_minutes === "number" ? minutesSpoken(a.return_minutes) : null };
}

function collectedOf(answer: unknown): number {
  const value = (answer as { collected_minutes?: unknown } | null)?.collected_minutes;
  return typeof value === "number" ? value : 0;
}

export const ACTS: Record<AdminAct, ActSpec> = {
  remove: {
    label: DETAIL_ADMIN.remove, title: DETAIL_ADMIN.removeTitle, body: DETAIL_ADMIN.removeBody, confirm: DETAIL_ADMIN.removeConfirm,
    alwaysOverdraft: false, mayOverdraft: true, tone: "danger",
    call: (r) => playersEndpoints.adminRemove(r.bookingId, r.participantId, r.reason, r.allowNegativeBalance),
    landed: (_was, now) => (!now || now.status === "removed" ? {} : null),
    done: (name, answer, organiser) => {
      const waiting = waitingReturn(answer);
      return waiting ? DETAIL_ADMIN.removedWaiting(name, waiting.amount, organiser) : DETAIL_ADMIN.removed(name);
    },
  },
  accept: {
    label: DETAIL_ADMIN.accept, title: DETAIL_ADMIN.acceptTitle, body: DETAIL_ADMIN.acceptBody, confirm: DETAIL_ADMIN.acceptConfirm,
    alwaysOverdraft: false, mayOverdraft: false, tone: "primary",
    call: (r) => playersEndpoints.adminAccept(r.bookingId, r.participantId, r.reason),
    landed: (_was, now) => (now?.status === "accepted" ? {} : null),
    done: (name) => DETAIL_ADMIN.accepted(name),
  },
  settle: {
    label: DETAIL_ADMIN.settle, title: DETAIL_ADMIN.settleTitle, body: DETAIL_ADMIN.settleBody, confirm: DETAIL_ADMIN.settleConfirm,
    alwaysOverdraft: false, mayOverdraft: true, tone: "primary",
    call: (r) => playersEndpoints.adminSettleOutside(r.bookingId, r.participantId, r.reason, r.allowNegativeBalance),
    landed: (_was, now) => (now?.settled_outside ? {} : null),
    done: (name, answer, organiser) => {
      const waiting = waitingReturn(answer);
      return waiting ? DETAIL_ADMIN.settledWaiting(name, waiting.amount, organiser) : DETAIL_ADMIN.settled(name);
    },
  },
  collect: {
    label: DETAIL_ADMIN.collect, title: DETAIL_ADMIN.collectTitle, body: DETAIL_ADMIN.collectBody, confirm: DETAIL_ADMIN.collectConfirm,
    alwaysOverdraft: true, mayOverdraft: true, tone: "primary",
    call: (r) => playersEndpoints.adminCollect(r.bookingId, r.participantId, r.reason),
    landed: (was, now) => (now && now.paid_minutes > was.paid_minutes ? { collected_minutes: now.paid_minutes - was.paid_minutes } : null),
    done: (name, answer) => DETAIL_ADMIN.collected(name, minutesSpoken(collectedOf(answer))),
  },
};

function fullName(name: string | null | undefined, fallback: string): string {
  return (name ?? "").trim() || fallback;
}

/** The return and its cover, off the server's `overdraft_not_authorised`, when it sent them. */
function returnFigures(refusal: unknown, partner: string) {
  if (!(refusal instanceof ApiError)) return undefined;
  const returned = refusal.detail("return_minutes");
  const covered = refusal.detail("covered_minutes");
  if (typeof returned !== "number" || typeof covered !== "number") return undefined;
  return {
    returned: minutesSpoken(returned), covered: minutesSpoken(covered), short: minutesSpoken(Math.max(0, returned - covered)), partner,
  };
}

/**
 * The go-ahead's sentence (R1 F2.13): WHO may go below zero, by full name — the desk must not
 * guess between two Sams — and by how much: for a collect the most it can be (the whole amount),
 * for a return the shortfall the server reported.
 */
export function overdraftSentence(act: AdminAct, player: DetailPlayer, detail: BookingDetail, refusal: unknown): string {
  const partner = fullName(player.name, DETAIL_ADMIN.title);
  if (act === "collect") return DETAIL_ADMIN.overdraftCollect(minutesSpoken(collectable(player)), partner);
  const organiser = fullName(detail.organiser.name, DETAIL_ADMIN.title);
  return DETAIL_ADMIN.overdraftReturn(organiser, returnFigures(refusal, partner));
}

