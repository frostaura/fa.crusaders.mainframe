import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, endpoints } from "@/lib/api";
import { describeBookingError, provesStaleGrid } from "@/lib/bookingErrors";
import { describeFailure } from "@/lib/errors";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { BOOK_SHEET, refusalReason } from "@/lib/bookingsCopy";
import type { ComboboxMember } from "@/components/ui/member-combobox";
import type { SelectedSlot } from "./types";
import type { MoneyRow, SlotLine } from "./SheetParts";
import {
  newIdempotencyKey, placeBooking, slotCount, slotFace, slotKey, stepsFor, useAdminQuote, whoProblem,
  type BookAs, type BookRun, type QuoteState, type StepId,
} from "./bookFlow";

/**
 * BookSheet's state machine, as one hook: which step, who pays, what the admin quote said, what
 * the confirm button is, and what the run did. The sheet itself only lays these out.
 */

/** What the page learns when a run returns, so it can reconcile the grid and the wallet chip. */
export type BookedOutcome = {
  /** Slots now booked (or held) — the grid can paint them before its re-read lands. */
  booked: SelectedSlot[];
  /**
   * The VIEWER's own balance after, when the viewer paid — hand it to `useBalance().apply`.
   * Null when an admin booked for somebody else: that figure is the member's wallet, and
   * painting it in the admin's own chip is the wrong-wallet mistake.
   */
  ownBalanceAfter: number | null;
  /** The member an admin booked for, when it was one. */
  forMemberId: string | null;
  hold: boolean;
};

export type BookFlowInput = {
  slots: SelectedSlot[];
  timezone: string;
  sliceMinutes: number;
  isAdmin: boolean;
  actorUserId: string | null;
  balanceCredits: number | null;
  bookAsUserId?: string | null;
  members?: ComboboxMember[];
  onBooked?: (outcome: BookedOutcome) => void;
  onStale?: () => void;
};

export type Primary =
  | { kind: "book"; label: string; allowNegativeBalance: boolean }
  | { kind: "reading"; label: string }
  /**
   * A member who is short: the Book button stays, named, but unavailable — its reason is the
   * "You need X more" notice, which carries the Top up link. Members never overdraw.
   */
  | { kind: "unavailable"; label: string }
  | { kind: "none" };

/** A double tap on Continue must not land its second half on the Book button that replaces it. */
const STEP_SETTLE_MS = 300;

/* ─────────────────────────────── members (admin) ─────────────────────────────── */

type MemberList = { list: ComboboxMember[]; loading: boolean };

/**
 * The members an admin can book for. Given by the page when it already has them; otherwise read
 * once here. The admin is left out: "Myself" is that choice, and god mode now covers it (R19).
 */
function useSheetMembers(isAdmin: boolean, given: ComboboxMember[] | undefined, actorUserId: string | null): MemberList {
  const [read, setRead] = useState<ComboboxMember[] | null>(null);
  const needed = isAdmin && !given;
  useEffect(() => {
    if (!needed) return undefined;
    let live = true;
    endpoints.adminMembers("Active").then(
      (rows) => {
        if (!live) return;
        setRead(rows.map((m) => ({ id: m.user_id, name: m.full_name, photoUrl: m.photo_url, balance: m.balance_credits })));
      },
      () => { if (live) setRead([]); },
    );
    return () => { live = false; };
  }, [needed]);
  const list = (given ?? read ?? []).filter((m) => m.id !== actorUserId);
  return { list, loading: needed && read === null };
}

function initialWho(isAdmin: boolean, bookAsUserId: string | null | undefined): BookAs {
  if (isAdmin && bookAsUserId) return { kind: "member", userId: bookAsUserId };
  return { kind: "self" };
}

function firstName(name: string | null): string | null {
  return name ? name.trim().split(/\s+/)[0] ?? name : null;
}

/* ─────────────────────────────── the figures ─────────────────────────────── */

function adminMoney(quote: QuoteState, name: string | null): MoneyRow[] | null {
  if (quote.status === "error" || quote.status === "idle") return null;
  const q = quote.status === "ready" ? quote.quote : null;
  return [
    { term: BOOK_SHEET.total, value: q?.total ?? null },
    { term: name ? BOOK_SHEET.theirBalanceNow(name) : BOOK_SHEET.balanceNow, value: q?.balance ?? null },
    { term: name ? BOOK_SHEET.theirBalanceAfter : BOOK_SHEET.balanceAfter, value: q?.after ?? null, total: true },
  ];
}

/**
 * A member's figures. Short, the last row is what they still need — never "Balance after −30.00
 * cr" in red: a member's balance cannot go below zero, so that figure is one their wallet can
 * never show (P4 walk).
 */
function memberMoney(total: number, balance: number | null, short: number | null): MoneyRow[] {
  if (balance === null) return [{ term: BOOK_SHEET.total, value: total, total: true }];
  return [
    { term: BOOK_SHEET.total, value: total },
    { term: BOOK_SHEET.balanceNow, value: balance },
    short !== null
      ? { term: BOOK_SHEET.stillNeeded, value: short, total: true }
      : { term: BOOK_SHEET.balanceAfter, value: balance - total, total: true },
  ];
}

function adminPrimary(quote: QuoteState, count: number, sendable: number, forName: string | null): Primary {
  if (quote.status === "loading" || quote.status === "idle") return { kind: "reading", label: BOOK_SHEET.primaryPending(count) };
  if (quote.status === "error" || sendable === 0) return { kind: "none" };
  return {
    kind: "book",
    label: BOOK_SHEET.primary(sendable, quote.quote.total, forName),
    allowNegativeBalance: quote.quote.overdraws,
  };
}

/** The sentence for a run that failed outright — a refusal with figures, or no answer at all. */
export function refusalSentence(error: unknown): string {
  return error instanceof ApiError
    ? describeBookingError(error, BOOK_SHEET.fallback)
    : describeFailure(error, { action: BOOK_SHEET.failedAction });
}

/* ─────────────────────────────── the hook ─────────────────────────────── */

export function useBookFlow(input: BookFlowInput) {
  const { slots, timezone, sliceMinutes, isAdmin, actorUserId, balanceCredits } = input;
  const steps = useMemo(() => stepsFor({ isAdmin }), [isAdmin]);
  const [stepIndex, setStepIndex] = useState(0);
  const [who, setWhoState] = useState<BookAs>(() => initialWho(isAdmin, input.bookAsUserId));
  const [key, setKey] = useState(() => newIdempotencyKey(isAdmin ? "ab" : "mb"));
  const [showProblem, setShowProblem] = useState(false);
  const [run, setRun] = useState<BookRun | null>(null);
  const settledAt = useRef(0);
  const members = useSheetMembers(isAdmin, input.members, actorUserId);

  const step: StepId = steps[Math.min(stepIndex, steps.length - 1)];
  const confirming = step === "confirm";
  const hold = isAdmin && who.kind === "hold";
  const quote = useAdminQuote(slots, who, isAdmin && confirming && !hold);

  const memberName = who.kind === "member" ? members.list.find((m) => m.id === who.userId)?.name ?? null : null;
  const face = useCallback((s: SelectedSlot) => {
    const f = slotFace(s, timezone, sliceMinutes);
    return `${f.day} · ${f.time}`;
  }, [timezone, sliceMinutes]);

  const ready = quote.state.status === "ready" ? quote.state.quote : null;
  const sendable = useMemo(
    () => (ready ? slots.filter((_, i) => !ready.refused.has(i)) : slots),
    [ready, slots],
  );

  const action = useAsyncAction(
    (allowNegativeBalance: boolean) => placeBooking({
      slots: sendable, who, isAdmin, actorUserId, idempotencyKey: key, allowNegativeBalance, face,
    }),
    {
      success: (result) => {
        setRun(result);
        const viewerPaid = !isAdmin || who.kind === "self";
        input.onBooked?.({
          booked: result.booked,
          ownBalanceAfter: viewerPaid ? result.balanceAfter : null,
          forMemberId: who.kind === "member" ? who.userId : null,
          hold: result.hold,
        });
      },
      failure: (error) => { if (provesStaleGrid(error)) input.onStale?.(); },
    },
  );

  const setWho = (next: BookAs) => {
    setWhoState(next);
    setShowProblem(false);
    // A different payer is a different request: never let a retry of the last one reuse its key.
    setKey(newIdempotencyKey(isAdmin ? "ab" : "mb"));
    action.reset();
  };

  const moveTo = (index: number) => {
    settledAt.current = Date.now();
    action.reset();
    setStepIndex(index);
  };

  const next = () => {
    if (step === "slots" && whoProblem(who)) {
      setShowProblem(true);
      return;
    }
    moveTo(Math.min(stepIndex + 1, steps.length - 1));
  };

  const submit = (allowNegativeBalance: boolean) => {
    if (Date.now() - settledAt.current < STEP_SETTLE_MS) return;
    void action.run(allowNegativeBalance);
  };

  /** In grid slots, the unit the action bar counted in — see `slotCount`. */
  const count = slotCount(slots);
  const refusedSlots = ready ? slotCount(slots.filter((_, i) => ready.refused.has(i))) : 0;
  const total = slots.reduce((n, s) => n + s.priceCredits, 0);
  const short = !isAdmin && balanceCredits !== null && balanceCredits < total ? total - balanceCredits : null;

  const lines: SlotLine[] = slots.map((s, i) => {
    const f = slotFace(s, timezone, sliceMinutes);
    const refusedCode = ready?.refused.has(i) ? ready.refused.get(i) ?? null : undefined;
    return {
      key: slotKey(s), courtName: s.courtName, day: f.day, time: f.time, duration: f.duration,
      price: isAdmin ? ready?.prices.get(i) ?? null : s.priceCredits,
      priceLoading: isAdmin && !hold && quote.state.status === "loading",
      refusal: refusedCode === undefined ? null : refusalReason(refusedCode),
      note: hold ? BOOK_SHEET.holdNote(who.kind === "hold" ? who.label : "") : undefined,
    };
  });

  let money: MoneyRow[] | null;
  let primary: Primary;
  if (hold) {
    money = [{ term: BOOK_SHEET.total, value: 0, text: BOOK_SHEET.free, total: true }];
    primary = { kind: "book", label: BOOK_SHEET.holdPrimary(count), allowNegativeBalance: false };
  } else if (isAdmin) {
    money = adminMoney(quote.state, memberName);
    primary = adminPrimary(quote.state, count, slotCount(sendable), firstName(memberName));
  } else {
    money = memberMoney(total, balanceCredits, short);
    const label = BOOK_SHEET.primary(count, total, null);
    primary = short !== null ? { kind: "unavailable", label } : { kind: "book", label, allowNegativeBalance: false };
  }

  return {
    steps, stepIndex: steps.indexOf(step), step, confirming, hold, count, refusedSlots,
    who, setWho, problem: showProblem ? whoProblem(who) : null,
    members, memberName,
    quote, ready, sendable, lines, money, primary, short,
    godMode: ready?.overdraws ? { name: memberName, balanceAfter: ready.after } : null,
    action, run,
    next, back: () => moveTo(Math.max(stepIndex - 1, 0)), submit,
  };
}

export type BookFlow = ReturnType<typeof useBookFlow>;
