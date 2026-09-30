import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, endpoints } from "@/lib/api";
import { describeBookingError, provesStaleGrid } from "@/lib/bookingErrors";
import { NotSent, UnsureOutcome, refuseWhenOffline, type Reread } from "@/lib/bookingOutcome";
import { describeFailure } from "@/lib/errors";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { BOOK_SHEET, refusalReason } from "@/lib/bookingsCopy";
import { PLAYERS_REFUSAL, playersRefusal } from "@/lib/playersCopy";
import type { ComboboxMember } from "@/components/ui/member-combobox";
import type { SelectedSlot } from "./types";
import type { MoneyRow, SlotLine } from "./SheetParts";
import {
  newIdempotencyKey, placeBooking, slotCount, slotFace, slotKey, stepsFor, useAdminQuote, whoProblem,
  type BookAs, type BookRun, type QuoteState, type StepId,
} from "./bookFlow";
import { usePlayersStep } from "./usePlayersStep";
import { recoverBooking, worthRereading } from "./bookRecovery";
import { useLateLanding } from "./useSendingGuard";

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
  /**
   * The outcome was read off a fresh schedule after the club's answer was lost (F1.1): the grid
   * already shows it, and the balance was not stated — re-read it.
   */
  proven?: boolean;
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
  /** What of a member's balance is held for partners (D11 §3a), for the line under the money. */
  held?: { held: number; owedBack?: number; until: string | null; parts?: { credits: number; until: string }[] } | null;
  /**
   * Re-reads the day behind the sheet and returns it (null when that read fails). Given, a lost
   * answer or a "taken" refusal is checked against the schedule before anything is said (F1.1).
   */
  reread?: Reread;
  /** The club's late-cancellation terms, from the day — said on Confirm before anything is charged (F1.10). */
  cancelTerms?: { penaltyPct: number; windowMinutes: number } | null;
  /**
   * Perf lane (2026-09-30): the slots a run is sending, the moment Book is pressed, so the grid
   * can mark them "Holding…" while the club answers. Called with null when a run FAILS; a run that
   * lands reports through `onBooked`, and the page clears the mark there (with the cells it paints).
   */
  onSending?: (slots: SelectedSlot[] | null) => void;
  /**
   * R4 I4-1 — whether the sheet is open, and a way to tell it a write is in flight: while one is,
   * the sheet refuses every way out, and an answer landing after it has gone is said in a toast.
   */
  sheetOpen?: boolean;
  onBusy?: (busy: boolean) => void;
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

/**
 * The step-change guard (perf report Frontend 1, R4 I4-2). Book replaces Continue under the same
 * finger, so the second half of a double tap on Continue lands on Book — that press, and only
 * that one, is ignored. It is told apart by the click's own count (`event.detail` ≥ 2, the
 * browser's double-click/double-tap counter), never by time alone: a deliberate first tap on Book
 * inside the window used to be dropped silently, and a member who tapped quickly got nothing.
 * A keyboard press (detail 0) and a single tap (detail 1) are always accepted.
 */
function useStepSettle() {
  const settledAt = useRef(0);
  const arm = () => { settledAt.current = Date.now(); };
  const isDoubleTapTail = (clicks: number) => clicks >= 2 && Date.now() - settledAt.current < STEP_SETTLE_MS;
  return { arm, isDoubleTapTail };
}

/**
 * R4 I4-1 / I4-2 — the one gate every write and every step change passes. `busy` is true from
 * Book until the club answers: its own flag, not `action.pending`, which a reset (a step or payer
 * change) cleared while the write was still on its way. While it is up nothing changes what the
 * sheet sends and nothing leaves it; `onBusy` tells the sheet at once (not in an effect), so a
 * press on the × a frame later is refused too. `ignoredTaps` counts a double tap's second half,
 * so the sheet can say why nothing happened.
 */
function useSendGate(onBusy: ((busy: boolean) => void) | undefined) {
  const settle = useStepSettle();
  const [busy, setBusy] = useState(false);
  const [ignoredTaps, setIgnoredTaps] = useState(0);
  const busyNow = useRef(false);
  /** `fn`, except while a write is in flight — then nothing (a step, payer or player change). */
  const whenIdle = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    if (!busyNow.current) fn(...args);
  };
  /** A step change re-arms the double-tap window. */
  const arm = () => {
    settle.arm();
    setIgnoredTaps(0);
  };
  const send = (clicks: number, work: () => Promise<unknown>) => {
    if (busyNow.current) return;
    if (settle.isDoubleTapTail(clicks)) {
      setIgnoredTaps((n) => n + 1);
      return;
    }
    setIgnoredTaps(0);
    busyNow.current = true;
    setBusy(true);
    onBusy?.(true);
    void work().finally(() => {
      busyNow.current = false;
      setBusy(false);
      onBusy?.(false);
    });
  };
  return { busy, ignoredTaps, whenIdle, arm, send };
}

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

/**
 * The desk's figures — the payer's SPENDABLE credits, never the raw balance (F1.4): shares held
 * for partners are not the desk's to book against, and "After this booking 35.00" over a member
 * who really stands at −90 was the quote contradicting its own god-mode notice.
 */
function adminMoney(quote: QuoteState, name: string | null): MoneyRow[] | null {
  if (quote.status === "error" || quote.status === "idle") return null;
  const q = quote.status === "ready" ? quote.quote : null;
  const terms = adminTerms(name, q !== null && q.spendable !== q.balance);
  return [
    { term: BOOK_SHEET.total, value: q?.total ?? null },
    { term: terms.now, value: q?.spendable ?? null },
    { term: terms.after, value: q?.after ?? null, total: true },
  ];
}

function adminTerms(name: string | null, holding: boolean) {
  if (name) return { now: holding ? BOOK_SHEET.theirAvailableNow(name) : BOOK_SHEET.theirBalanceNow(name), after: BOOK_SHEET.theirBalanceAfter };
  return holding
    ? { now: BOOK_SHEET.availableNow, after: BOOK_SHEET.availableAfter }
    : { now: BOOK_SHEET.balanceNow, after: BOOK_SHEET.balanceAfter };
}

/**
 * A member's figures. Short, the last row is what they still need — never "Balance after −30.00
 * cr" in red: a member's balance cannot go below zero, so that figure is one their wallet can
 * never show (P4 walk). With anything held for partners the rows say "Available", the figure
 * every spend reads — and the Done line after the booking says the same figure (F1.3).
 */
function memberMoney(total: number, balance: number | null, short: number | null, holding: boolean): MoneyRow[] {
  if (balance === null) return [{ term: BOOK_SHEET.total, value: total, total: true }];
  return [
    { term: BOOK_SHEET.total, value: total },
    { term: holding ? BOOK_SHEET.availableNow : BOOK_SHEET.balanceNow, value: balance },
    short !== null
      ? { term: BOOK_SHEET.stillNeeded, value: short, total: true }
      : { term: holding ? BOOK_SHEET.availableAfter : BOOK_SHEET.balanceAfter, value: balance - total, total: true },
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

/**
 * The sentence for a run that failed outright — a refusal with figures, or no answer at all. A
 * booking sent with players can be refused for the players (a split that cannot work, a member
 * who left); those codes are the players feature's sentences, everything else the booking's.
 */
export function refusalSentence(error: unknown, withPlayers = false, forName: string | null = null): string {
  if (withPlayers && error instanceof ApiError && error.code !== null && error.code in PLAYERS_REFUSAL) {
    return playersRefusal(error);
  }
  return error instanceof ApiError || error instanceof UnsureOutcome || error instanceof NotSent
    ? describeBookingError(error, BOOK_SHEET.fallback, { action: "book", forName })
    : describeFailure(error, { action: BOOK_SHEET.failedAction });
}

/** Where the steps go next — a step id, not an index, so inserting Split never shifts Confirm. */
function neighbour(steps: readonly StepId[], at: StepId, by: 1 | -1): StepId {
  const index = Math.max(0, steps.indexOf(at));
  return steps[Math.min(Math.max(index + by, 0), steps.length - 1)];
}

/* ─────────────────────────────── the hook ─────────────────────────────── */

export function useBookFlow(input: BookFlowInput) {
  const { slots, timezone, sliceMinutes, isAdmin, actorUserId, balanceCredits } = input;
  const [stepId, setStepId] = useState<StepId>(() => stepsFor({ isAdmin })[0]);
  const [who, setWhoState] = useState<BookAs>(() => initialWho(isAdmin, input.bookAsUserId));
  const [key, setKey] = useState(() => newIdempotencyKey(isAdmin ? "ab" : "mb"));
  const [showProblem, setShowProblem] = useState(false);
  const [run, setRun] = useState<BookRun | null>(null);
  const gate = useSendGate(input.onBusy);
  const late = useLateLanding(input.sheetOpen);

  const members = useSheetMembers(isAdmin, input.members, actorUserId);

  const onEdit = gate.whenIdle(() => {
    // A different game is a different request: never let a retry of the last one reuse its key.
    setKey(newIdempotencyKey("mb"));
    action.reset();
  });
  const players = usePlayersStep({
    enabled: !isAdmin, prices: slots.map((s) => s.priceCredits), step: stepId, onEdit: () => onEdit(),
  });
  const steps = useMemo(() => stepsFor({ isAdmin, paying: players.paying }), [isAdmin, players.paying]);
  const step: StepId = steps.includes(stepId) ? stepId : steps[steps.length - 1];
  const stepIndex = steps.indexOf(step);
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
    // R3 I-4: offline, nothing is sent — and the sheet says so, rather than "can't tell".
    async (allowNegativeBalance: boolean) => {
      refuseWhenOffline();
      input.onSending?.(sendable);
      return placeBooking({
        slots: sendable, who, isAdmin, actorUserId, idempotencyKey: key, allowNegativeBalance, face,
        players: isAdmin ? null : players.payload,
      }).catch((error: unknown) => recoverBooking(error, sendable, who, face, input.reread));
    },
    {
      success: (result) => {
        setRun(result);
        late.sayIfGone("success", () => BOOK_SHEET.landedLate(result.booked.map(face)));
        const viewerPaid = !isAdmin || who.kind === "self";
        input.onBooked?.({
          booked: result.booked,
          ownBalanceAfter: viewerPaid ? result.balanceAfter : null,
          forMemberId: who.kind === "member" ? who.userId : null,
          hold: result.hold,
          proven: result.proven,
        });
      },
      // A re-read already happened on the way here when there was one to make.
      failure: (error) => {
        input.onSending?.(null);
        late.sayIfGone("danger", () => refusalSentence(error, Boolean(players.payload)));
        const reread = Boolean(input.reread) && worthRereading(error);
        if (!reread && provesStaleGrid(error)) input.onStale?.();
      },
    },
  );

  const setWho = gate.whenIdle((next: BookAs) => {
    setWhoState(next);
    setShowProblem(false);
    // A different payer is a different request: never let a retry of the last one reuse its key.
    setKey(newIdempotencyKey(isAdmin ? "ab" : "mb"));
    action.reset();
  });

  const moveTo = gate.whenIdle((id: StepId) => {
    gate.arm();
    action.reset();
    setStepId(id);
  });

  const next = () => {
    if (step === "slots" && whoProblem(who)) {
      setShowProblem(true);
      return;
    }
    // A split the phone already knows cannot work is said on the step, not discovered on Book.
    if (step === "split" && players.problem) return;
    moveTo(neighbour(steps, step, 1));
  };

  const back = () => {
    if (players.picking !== null) players.closePicker();
    else moveTo(neighbour(steps, step, -1));
  };

  /** @param clicks the press's `event.detail` — see `useStepSettle`. */
  const submit = (allowNegativeBalance: boolean, clicks = 0) => {
    gate.send(clicks, () => action.run(allowNegativeBalance));
  };

  /** In grid slots, the unit the action bar counted in — see `slotCount`. */
  const count = slotCount(slots);
  const refusedSlots = ready ? slotCount(slots.filter((_, i) => ready.refused.has(i))) : 0;
  const total = slots.reduce((n, s) => n + s.priceCredits, 0);
  const short = !isAdmin && balanceCredits !== null && balanceCredits < total ? total - balanceCredits : null;
  const memberHeld = isAdmin ? null : input.held ?? null;
  const memberReserved = memberHeld ? memberHeld.held + (memberHeld.owedBack ?? 0) : 0;

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
    money = memberMoney(total, balanceCredits, short, memberReserved > 0);
    const label = BOOK_SHEET.primary(count, total, null);
    primary = short !== null ? { kind: "unavailable", label } : { kind: "book", label, allowNegativeBalance: false };
  }

  return {
    steps, stepIndex, step, confirming, hold, count, refusedSlots, players,
    who, setWho, problem: showProblem ? whoProblem(who) : null,
    members, memberName,
    quote, ready, sendable, lines, money, primary, short,
    godMode: ready?.overdraws ? { name: memberName, balanceAfter: ready.after, owedBack: ready.owedBack } : null,
    action, run,
    next, back, submit, face, timezone,
    /** A write is on its way: nothing may leave the sheet or change what it sends (R4 I4-1). */
    busy: gate.busy,
    ignoredTaps: gate.ignoredTaps,
    held: memberHeld,
    /**
     * What of the payer's balance cannot be spent — the member's held + owed back, or the
     * desk's quote's difference — so the Done line says the SAME figure Confirm did (F1.3).
     */
    reserved: isAdmin ? (ready ? ready.balance - ready.spendable : 0) : memberReserved,
  };
}

export type BookFlow = ReturnType<typeof useBookFlow>;
