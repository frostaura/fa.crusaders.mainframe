import { useEffect, useId, useRef } from "react";
import { Link } from "react-router-dom";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { AnimatedAlert, AnimatedCheck } from "@/components/ui/feedback-marks";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Warning } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { MemberCombobox } from "@/components/ui/member-combobox";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { ApiError } from "@/lib/api";
import { describeFailure } from "@/lib/errors";
import { BOOK_SHEET, RESULTS_LABEL } from "@/lib/bookingsCopy";
import { BulkResults } from "./BulkResults";
import { GodModeNotice } from "./GodModeNotice";
import { MoneyRows, SlotList, Stepper } from "./SheetParts";
import { slotCount, type BookAs } from "./bookFlow";
import { refusalSentence, useBookFlow, type BookFlow, type BookFlowInput } from "./useBookFlow";

export type { BookedOutcome } from "./useBookFlow";

/**
 * Booking one slot or many (R7, R19, D8) — a dialog that is a bottom sheet on a phone, with the
 * close × every dialog carries.
 *
 * <p>
 * <b>A stepper, so the P11 steps slot in.</b> Slots → [Players → Split, reserved for P11] →
 * Confirm. Each step declares whether it applies (`bookFlow.stepsFor`): an admin gets Slots,
 * where "Book as" is decided; a member, who has nothing to decide there yet, goes straight to
 * Confirm, which always lists the slots with their day, time and length.
 * </p>
 *
 * <p>
 * <b>Admin god mode is quoted, never discovered.</b> The admin's Confirm asks the quote route
 * first and, when the booking takes the payer below zero, says so in a `GodModeNotice` and
 * sends `allowNegativeBalance` on purpose. Members never overdraw: a member who is short is told
 * what they need ("You need 30.00 cr more") with a Top up link beside it, and the Book button
 * stays in its place, unavailable, described by that sentence.
 * </p>
 *
 * <p>
 * <b>Pending is a spinner in the button, never a frozen one</b> (`useAsyncAction`). A single
 * booking that is refused stays here and says why; a run that lands shows the tick and a row per
 * item, so a partial batch is read rather than guessed.
 * </p>
 */
export type BookSheetProps = BookFlowInput & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function BookSheet(props: BookSheetProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-sheet="book">
        {props.slots.length > 0 ? <BookFlowView {...props} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function BookFlowView(props: BookSheetProps & { onClose: () => void }) {
  const flow = useBookFlow(props);
  const body = useRef<HTMLDivElement>(null);
  /** The sentence an unavailable Book button is described by. */
  const reasonId = useId();

  // A new step is a new screen: take a screen reader to its top rather than leaving it on a
  // button that has just changed meaning under it.
  useEffect(() => {
    if (flow.stepIndex > 0 || flow.run) body.current?.focus();
  }, [flow.stepIndex, flow.run]);

  const title = flow.hold ? BOOK_SHEET.holdTitle(flow.count) : BOOK_SHEET.title(flow.count);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className={flow.run ? "sr-only" : undefined}>
          {flow.hold ? BOOK_SHEET.holdDescription : BOOK_SHEET.description}
        </DialogDescription>
        {flow.run ? null : (
          <Stepper names={flow.steps.map((s) => BOOK_SHEET.steps[s])} current={flow.stepIndex} />
        )}
      </DialogHeader>
      <DialogBody ref={body} tabIndex={-1} className="pb-4 outline-none">
        {/* An inner stack, not a grid on the scroller itself: a grid item that clips (the slot
            card) has no minimum height, so a height-capped grid squashed it instead of scrolling. */}
        <div className="flex flex-col gap-4">
          {flow.run ? <ResultView flow={flow} /> : <StepView flow={flow} isAdmin={props.isAdmin} reasonId={reasonId} />}
        </div>
      </DialogBody>
      <BookFooter flow={flow} onClose={props.onClose} reasonId={reasonId} />
    </>
  );
}

/* ─────────────────────────────── steps ─────────────────────────────── */

function StepView({ flow, isAdmin, reasonId }: { flow: BookFlow; isAdmin: boolean; reasonId: string }) {
  if (flow.step === "slots") {
    return (
      <>
        <SlotList lines={flow.lines.map((l) => ({ ...l, price: null, note: undefined, priceLoading: false }))}
          label={BOOK_SHEET.slotsLabel} refusedWord={BOOK_SHEET.notBookable} />
        {isAdmin ? <BookAsChoice flow={flow} /> : null}
      </>
    );
  }
  return <ConfirmStep flow={flow} reasonId={reasonId} />;
}

function ConfirmStep({ flow, reasonId }: { flow: BookFlow; reasonId: string }) {
  const failed = flow.action.status === "error" ? flow.action.error : null;
  const refused = flow.refusedSlots;
  return (
    <>
      <SlotList lines={flow.lines} label={BOOK_SHEET.slotsLabel} refusedWord={BOOK_SHEET.notBookable} />
      {refused > 0 ? (
        <Alert tone="warning" live="polite">
          {flow.sendable.length === 0 ? BOOK_SHEET.noneBookable : BOOK_SHEET.someNotBookable(refused)}
        </Alert>
      ) : null}
      <QuoteProblem flow={flow} />
      {flow.money ? <MoneyRows rows={flow.money} label={BOOK_SHEET.total} /> : null}
      {flow.quote.state.status === "loading" ? <span role="status" className="sr-only">{BOOK_SHEET.quoteReading}</span> : null}
      {flow.godMode ? <GodModeNotice name={flow.godMode.name} balanceAfter={flow.godMode.balanceAfter} /> : null}
      {flow.short !== null ? <ShortNotice shortBy={flow.short} reasonId={reasonId} /> : null}
      {failed ? <Alert tone="danger">{refusalSentence(failed)}</Alert> : null}
    </>
  );
}

/**
 * A member who is short: what they need, and the way to get it. The sentence is the Book
 * button's description (`reasonId`); the Top up is navigation, so it is a link in a button's
 * clothes. `role="status"`: it is the standing state of this sheet, not an event.
 */
function ShortNotice({ shortBy, reasonId }: { shortBy: number; reasonId: string }) {
  return (
    <div role="status" data-short="" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warning-strong/30 bg-warning-soft p-3 text-warning-strong">
      <Warning size={20} weight="bold" aria-hidden="true" className="shrink-0" />
      <p id={reasonId} className="grid min-w-0 flex-1 basis-40 gap-0.5 text-sm">
        <span className="font-semibold">{BOOK_SHEET.needMore(shortBy)}</span>
        <span>{BOOK_SHEET.needMoreBody}</span>
      </p>
      <Button asChild variant="outline" size="sm" className="ml-auto shrink-0">
        <Link to="/wallet/topup">{BOOK_SHEET.topUp}</Link>
      </Button>
    </div>
  );
}

/** A quote that could not be read: the refusal it carried, or the failure, and a retry. */
function QuoteProblem({ flow }: { flow: BookFlow }) {
  const state = flow.quote.state;
  if (state.status !== "error") return null;
  const sentence = state.error instanceof ApiError
    ? refusalSentence(state.error)
    : describeFailure(state.error, { action: BOOK_SHEET.quoteAction });
  return (
    <div className="grid justify-items-start gap-3">
      <Alert tone="danger" className="w-full">{sentence}</Alert>
      <Button variant="outline" onClick={flow.quote.retry}>{BOOK_SHEET.retry}</Button>
    </div>
  );
}

/* ─────────────────────────────── book as (admin) ─────────────────────────────── */

function BookAsChoice({ flow }: { flow: BookFlow }) {
  const { who, setWho } = flow;
  const pick = (kind: string) => {
    if (kind === who.kind) return;
    if (kind === "member") setWho({ kind: "member", userId: null });
    else if (kind === "hold") setWho({ kind: "hold", label: "" });
    else setWho({ kind: "self" });
  };
  const labelId = useId();
  return (
    <div className="grid gap-3">
      <p id={labelId} className="text-sm font-semibold text-text-primary">{BOOK_SHEET.bookAs}</p>
      <RadioGroup value={who.kind} onValueChange={pick} aria-labelledby={labelId}>
        <RadioCard value="self" title={BOOK_SHEET.asSelf} description={BOOK_SHEET.asSelfHint} />
        <RadioCard value="member" title={BOOK_SHEET.asMember} description={BOOK_SHEET.asMemberHint} />
        <RadioCard value="hold" title={BOOK_SHEET.asHold} description={BOOK_SHEET.asHoldHint} />
      </RadioGroup>
      <WhoDetail flow={flow} who={who} />
    </div>
  );
}

function WhoDetail({ flow, who }: { flow: BookFlow; who: BookAs }) {
  if (who.kind === "member") {
    return (
      <MemberCombobox
        members={flow.members.list}
        loading={flow.members.loading}
        value={who.userId}
        onChange={(id) => flow.setWho({ kind: "member", userId: id })}
        label={BOOK_SHEET.memberLabel}
        placeholder={BOOK_SHEET.memberPlaceholder}
        error={flow.problem === "member" ? BOOK_SHEET.memberMissing : null}
      />
    );
  }
  if (who.kind === "hold") {
    return (
      <Field invalid={flow.problem === "hold"}>
        <FieldLabel>{BOOK_SHEET.holdLabel}</FieldLabel>
        <Input
          value={who.label}
          maxLength={128}
          placeholder={BOOK_SHEET.holdPlaceholder}
          onChange={(e) => flow.setWho({ kind: "hold", label: e.target.value })}
        />
        {flow.problem === "hold" ? <FieldError>{BOOK_SHEET.holdMissing}</FieldError> : null}
      </Field>
    );
  }
  return null;
}

/* ─────────────────────────────── the result ─────────────────────────────── */

function ResultView({ flow }: { flow: BookFlow }) {
  const run = flow.run;
  if (!run) return null;
  // In grid slots, like the title — "All 3 booked" under a bar that ticked three.
  const booked = slotCount(run.booked);
  const total = Math.max(booked, slotCount(flow.sendable));
  let heading: string;
  if (booked === 0) heading = BOOK_SHEET.noneBookedTitle;
  else heading = run.hold ? BOOK_SHEET.heldTitle(booked, total) : BOOK_SHEET.bookedTitle(booked, total);
  const forName = flow.who.kind === "member" ? flow.memberName : null;
  const admin = isAdminRun(flow);
  return (
    <>
      <div role="status" className="flex items-center gap-3">
        {booked > 0
          ? <AnimatedCheck size={40} className="text-success-strong" />
          : <AnimatedAlert size={40} className="text-danger-strong" />}
        <span className="grid gap-0.5">
          <span className="text-base font-semibold text-text-primary">{heading}</span>
          {run.balanceAfter !== null && !run.hold ? (
            <span className="text-sm text-text-secondary">{BOOK_SHEET.balanceLine(run.balanceAfter, forName)}</span>
          ) : null}
        </span>
      </div>
      {run.halted === "insufficient_balance" ? (
        <Alert tone="warning" live="polite">
          {admin ? BOOK_SHEET.haltedShortAdmin(forName ?? BOOK_SHEET.you) : BOOK_SHEET.haltedShort}
        </Alert>
      ) : null}
      <BulkResults rows={run.rows} label={RESULTS_LABEL.book} />
    </>
  );
}

function isAdminRun(flow: BookFlow): boolean {
  return flow.steps.includes("slots");
}

/* ─────────────────────────────── the footer ─────────────────────────────── */

function BookFooter({ flow, onClose, reasonId }: { flow: BookFlow; onClose: () => void; reasonId: string }) {
  if (flow.run) return <ResultFooter flow={flow} onClose={onClose} />;
  const first = flow.stepIndex === 0;
  return (
    <DialogFooter>
      <Button variant="outline" onClick={first ? onClose : flow.back}>
        {first ? BOOK_SHEET.cancel : BOOK_SHEET.back}
      </Button>
      {flow.confirming ? <PrimaryButton flow={flow} reasonId={reasonId} /> : <Button onClick={flow.next}>{BOOK_SHEET.next}</Button>}
    </DialogFooter>
  );
}

function PrimaryButton({ flow, reasonId }: { flow: BookFlow; reasonId: string }) {
  const { primary } = flow;
  if (primary.kind === "none") return null;
  if (primary.kind === "unavailable") {
    // `aria-disabled`, never `disabled`: it stays focusable, so a reader reaches it and hears
    // why (its description) — and with no handler, a press does nothing.
    return (
      <Button aria-disabled="true" aria-describedby={reasonId} data-unavailable="" className="cursor-not-allowed opacity-50 hover:bg-primary">
        {primary.label}
      </Button>
    );
  }
  if (primary.kind === "reading") {
    return <Button pending data-reading="">{primary.label}</Button>;
  }
  return (
    <Button pending={flow.action.pending} onClick={() => flow.submit(primary.allowNegativeBalance)}>
      {primary.label}
    </Button>
  );
}

function ResultFooter({ flow, onClose }: { flow: BookFlow; onClose: () => void }) {
  const halted = flow.run?.halted === "insufficient_balance";
  const admin = isAdminRun(flow);
  return (
    <DialogFooter>
      {halted && !admin ? (
        <Button variant="outline" asChild>
          <Link to="/wallet/topup">{BOOK_SHEET.topUp}</Link>
        </Button>
      ) : null}
      {halted ? (
        <Button variant="outline" pending={flow.action.pending} onClick={() => flow.submit(admin)}>
          {admin ? BOOK_SHEET.bookRestAnyway : BOOK_SHEET.retry}
        </Button>
      ) : null}
      <Button onClick={onClose}>{BOOK_SHEET.done}</Button>
    </DialogFooter>
  );
}
