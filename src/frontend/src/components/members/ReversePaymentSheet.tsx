import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Minutes } from "@/components/Minutes";
import { SendingNote, Stepper } from "@/components/bookings/SheetParts";
import { useSendingGuard, type SendingGuard } from "@/components/bookings/useSendingGuard";
import { useToast } from "@/components/toastContext";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { AnimatedCheck } from "@/components/ui/feedback-marks";
import { HourglassMedium } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { useIsSmUp } from "@/components/ui/use-media-query";
import { adminEndpoints, REVERSAL_KINDS, type ReversalKind, type ReversibleEntry } from "@/lib/adminApi";
import { clubDayAndClock } from "@/lib/clubClock";
import { REVERSAL_COPY as COPY, REVERSAL_LOST } from "@/lib/reversalCopy";
import { cn, formatMoney } from "@/lib/utils";
import type { AdjustmentKey } from "./adjustmentAttempt";
import { DESK_FOOTER_CLASS, DeskConfirmFooter } from "./DeskConfirmFooter";
import { attemptReversal, checkMinutes, checkZar, type ReversalOutcome } from "./reversalAttempt";
import { useMenuReturnFocus } from "./useMenuReturnFocus";
import { useStepFocus } from "./useStepFocus";

/**
 * Refund or chargeback (BM-6): rand the club gave back for ONE of a member's purchases, posted as a
 * `PaymentReversal` naming it, so the revenue report finally nets what the club handed back.
 *
 * <p>
 * <b>Three steps, as every desk money sheet:</b> which purchase · how much went back (rand, and the
 * minutes taken back with it — two numbers, because they are two different things) · is this right.
 * The purchase list is the server's (`GET /admin/minutes/{id}/reversible`) with what is still left
 * on each, and nothing beyond what is left can be typed: the server holds the same cap under the
 * member's payer lock, and a second desk that got there first is said in words (409).
 * </p>
 *
 * <p>
 * <b>The same press discipline as a sale</b> (`reversalAttempt`): one key per intended reversal, a
 * lost reply looked up on the purchase itself, the sheet held open while the press is on its way,
 * and the receipt stays — money deserves more than a toast.
 * </p>
 */
export type ReversePaymentSheetProps = {
  userId: string;
  name: string;
  /** What the member has now, or null where the read failed. Null is NOT zero. */
  balance: number | null;
  onClose: () => void;
  /** The server's balance after, or null where a lost reply was found and the balance is not known. */
  onRecorded: (balanceAfter: number | null) => void;
  returnFocus?: () => HTMLElement | null | undefined;
};

type ListState = { status: "loading" } | { status: "failed"; error: unknown } | { status: "ready"; entries: ReversibleEntry[] };
type Complaints = { entry?: string; zar?: string; minutes?: string; note?: string };
type Receipt = { kind: ReversalKind; zar: number; balanceAfter: number | null; zarLeft: number | null; minutesLeft: number | null; recovered: boolean };

function useReversible(userId: string) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const read = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", entries: (await adminEndpoints.reversible(userId)).entries });
    } catch (error) {
      setState({ status: "failed", error });
    }
  }, [userId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void read(); }, [read]);
  /** A 409 said what is left now: the purchase takes those figures, and the check is re-run against them. */
  const settleLeft = useCallback((entryId: string, zarLeft: number, minutesLeft: number) => {
    setState((now) => (now.status === "ready"
      ? { status: "ready", entries: now.entries.map((e) => (e.entry_id === entryId ? { ...e, zar_left: zarLeft, minutes_left: minutesLeft } : e)) }
      : now));
  }, []);
  return { state, read, settleLeft };
}

function useReversalFlow(list: ListState) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [kind, setKind] = useState<ReversalKind>("refund");
  const [zarText, setZarText] = useState("");
  const [minutesText, setMinutesText] = useState("");
  const [note, setNote] = useState("");
  const [complaints, setComplaints] = useState<Complaints>({});
  const [done, setDone] = useState<Receipt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const entry = list.status === "ready" ? list.entries.find((e) => e.entry_id === entryId) ?? null : null;
  const zar = entry ? checkZar(zarText, entry.zar_left) : { value: null };
  const minutes = entry ? checkMinutes(minutesText, entry.minutes_left) : { value: null };

  /** Choosing a purchase starts both figures at everything still left on it. */
  const choose = (id: string) => {
    const chosen = list.status === "ready" ? list.entries.find((e) => e.entry_id === id) : undefined;
    setEntryId(id);
    if (chosen) {
      setZarText(chosen.zar_left.toFixed(2));
      setMinutesText(String(chosen.minutes_left));
    }
    setComplaints({});
    setNotice(null);
  };
  const toAmounts = () => {
    if (!entry) setComplaints({ entry: COPY.pickMissing });
    else { setComplaints({}); setStep(2); }
  };
  const toCheck = () => {
    const found: Complaints = { zar: zar.complaint, minutes: minutes.complaint, note: note.trim() ? undefined : COPY.noteMissing };
    setComplaints(found);
    if (!Object.values(found).some(Boolean)) setStep(3);
  };
  return {
    step, setStep, entry, choose, kind, setKind, zarText, setZarText, minutesText, setMinutesText, note, setNote,
    complaints, done, setDone, notice, setNotice, toAmounts, toCheck, zar: zar.value, minutes: minutes.value,
  };
}

type Flow = ReturnType<typeof useReversalFlow>;
type List = ReturnType<typeof useReversible>;

function useReversalPress(props: ReversePaymentSheetProps, flow: Flow, list: List) {
  const toast = useToast();
  const key = useRef<AdjustmentKey>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const press = async (): Promise<string> => {
    const { entry, zar, minutes, kind } = flow;
    if (!entry || zar === null || minutes === null || inFlight.current) return COPY.pickMissing;
    inFlight.current = true;
    setBusy(true);
    try {
      const outcome = await attemptReversal({ userId: props.userId, entry, kind, zar, minutes, reason: flow.note, name: props.name }, key);
      return settle(outcome, { props, flow, list, toast, zar });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, press };
}

type SettleContext = { props: ReversePaymentSheetProps; flow: Flow; list: List; toast: ReturnType<typeof useToast>; zar: number };

function settle(outcome: ReversalOutcome, ctx: SettleContext): string {
  const { props, flow, list, toast, zar } = ctx;
  if (outcome.kind === "exceeds") {
    if (flow.entry && outcome.zarLeft !== null && outcome.minutesLeft !== null) list.settleLeft(flow.entry.entry_id, outcome.zarLeft, outcome.minutesLeft);
    flow.setNotice(outcome.message);
    flow.setStep(2);
    return outcome.message;
  }
  if (outcome.kind === "failed") {
    toast.push({ tone: "danger", text: outcome.message, unchanged: outcome.unchanged, durationMs: 8000 });
    return outcome.said;
  }
  props.onRecorded(outcome.balanceAfterMinutes);
  flow.setDone({
    kind: flow.kind, zar, balanceAfter: outcome.balanceAfterMinutes, zarLeft: outcome.zarLeft, minutesLeft: outcome.minutesLeft,
    recovered: outcome.recovered,
  });
  return COPY.doneSentence(flow.kind, formatMoney(zar), outcome.balanceAfterMinutes);
}

export function ReversePaymentSheet(props: ReversePaymentSheetProps) {
  const { name, onClose } = props;
  const wide = useIsSmUp();
  const list = useReversible(props.userId);
  const flow = useReversalFlow(list.state);
  const press = useReversalPress(props, flow, list);
  const guard = useSendingGuard((open) => { if (!open) onClose(); });
  const backToMenu = useMenuReturnFocus(props.returnFocus);
  const [stepRef, stepLabel] = useStepFocus(flow.step, COPY.steps, flow.done !== null);
  return (
    <Sheet open onOpenChange={guard.onOpenChange}>
      <SheetContent side={wide ? "right" : "bottom"} data-sheet="reverse-payment" onCloseAutoFocus={backToMenu}>
        <SheetHeader>
          <SheetTitle>{COPY.titleFor(name)}</SheetTitle>
          <SheetDescription>{COPY.description}</SheetDescription>
          {flow.done ? null : <Stepper names={COPY.steps} current={flow.step - 1} />}
        </SheetHeader>
        <SheetBody ref={stepRef} tabIndex={-1} role="group" aria-label={stepLabel} className="flex flex-col gap-4 pb-4 outline-none">
          {flow.notice && !flow.done ? <Alert tone="warning" live="standing" announceKey={flow.notice}>{flow.notice}</Alert> : null}
          <ReversalBody flow={flow} list={list} balance={props.balance} name={name} />
        </SheetBody>
        <SheetFooter className={cn("sm:items-end", flow.step === 3 && !flow.done && DESK_FOOTER_CLASS)}>
          <SendingNote text={press.busy ? COPY.sending(name) : null} refused={guard.refused} />
          <ReversalFooter flow={flow} guard={guard} press={press} list={list.state} name={name} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

type BodyProps = { flow: Flow; list: List; balance: number | null; name: string };

function ReversalBody({ flow, list, balance, name }: BodyProps) {
  if (flow.done) return <ReversalReceipt done={flow.done} />;
  if (flow.step === 2 && flow.entry) return <AmountsStep flow={flow} entry={flow.entry} />;
  if (flow.step === 3 && flow.entry) return <ReversalCheck flow={flow} entry={flow.entry} balance={balance} />;
  const state = list.state;
  return (
    <StateBlock
      loading={state.status === "loading"}
      error={state.status === "failed" ? state.error : null}
      action={COPY.loadAction}
      onRetry={() => void list.read()}
      empty={state.status === "ready" && state.entries.length === 0}
      emptyTitle={COPY.emptyTitle}
      emptyHint={COPY.emptyHint}
      emptyIcon={HourglassMedium}
      skeleton={<ListSkeleton />}
    >
      {state.status === "ready" ? <PurchaseChoice flow={flow} entries={state.entries} name={name} /> : null}
    </StateBlock>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2].map((row) => <Skeleton key={row} className="h-16 w-full" />)}
    </div>
  );
}

/** Each purchase a card: when, what, what it took — and what can still go back, or that nothing can. */
function PurchaseChoice({ flow, entries, name }: { flow: Flow; entries: ReversibleEntry[]; name: string }) {
  const errorId = useId();
  const complaint = flow.complaints.entry;
  return (
    <Field>
      <FieldLabel>{COPY.pickLabel(name)}</FieldLabel>
      <RadioGroup
        value={flow.entry?.entry_id ?? ""}
        onValueChange={flow.choose}
        aria-label={COPY.pickLabel(name)}
        aria-invalid={complaint ? true : undefined}
        aria-describedby={complaint ? errorId : undefined}
      >
        {entries.map((e) => (
          <RadioCard
            key={e.entry_id}
            value={e.entry_id}
            disabled={e.zar_left <= 0}
            title={<PurchaseTitle entry={e} />}
            description={e.zar_left <= 0 ? COPY.nothingLeft : COPY.leftLine(formatMoney(e.zar_left), e.minutes_left)}
          />
        ))}
      </RadioGroup>
      <FieldError id={errorId}>{complaint}</FieldError>
    </Field>
  );
}

function PurchaseTitle({ entry }: { entry: ReversibleEntry }) {
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span>{entry.reason ?? COPY.purchaseLine(formatMoney(entry.zar_paid), entry.amount_minutes)}</span>
      <span className="text-sm font-normal text-text-secondary">{clubDayAndClock(entry.created_at)}</span>
    </span>
  );
}

function AmountsStep({ flow, entry }: { flow: Flow; entry: ReversibleEntry }) {
  return (
    <>
      <Field>
        <FieldLabel>{COPY.kindLabel}</FieldLabel>
        <RadioGroup value={flow.kind} onValueChange={(v) => flow.setKind(v as ReversalKind)} aria-label={COPY.kindLabel}>
          {REVERSAL_KINDS.map((k) => <RadioCard key={k} value={k} title={COPY.kinds[k].title} description={COPY.kinds[k].hint} />)}
        </RadioGroup>
      </Field>
      <Field>
        <FieldLabel>{COPY.zarLabel}</FieldLabel>
        <Input inputMode="decimal" autoComplete="off" className="tabular-nums" value={flow.zarText}
          aria-invalid={flow.complaints.zar ? true : undefined} onChange={(e) => flow.setZarText(e.target.value)} />
        <FieldDescription>{COPY.zarHelp(formatMoney(entry.zar_left))}</FieldDescription>
        <FieldError>{flow.complaints.zar}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{COPY.minutesLabel}</FieldLabel>
        <Input inputMode="numeric" autoComplete="off" className="tabular-nums" value={flow.minutesText}
          aria-invalid={flow.complaints.minutes ? true : undefined} onChange={(e) => flow.setMinutesText(e.target.value)} />
        <FieldDescription>{COPY.minutesHelp(entry.minutes_left)}</FieldDescription>
        <FieldError>{flow.complaints.minutes}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{COPY.noteLabel} <span className="font-normal text-text-muted">(required)</span></FieldLabel>
        <Input autoComplete="off" aria-required="true" value={flow.note} placeholder={COPY.notePlaceholder}
          aria-invalid={flow.complaints.note ? true : undefined} onChange={(e) => flow.setNote(e.target.value)} />
        <FieldDescription>{COPY.noteHint}</FieldDescription>
        <FieldError>{flow.complaints.note}</FieldError>
      </Field>
    </>
  );
}

function ReversalCheck({ flow, entry, balance }: { flow: Flow; entry: ReversibleEntry; balance: number | null }) {
  const minutes = flow.minutes ?? 0;
  const zar = formatMoney(flow.zar ?? 0);
  const after = balance === null ? null : balance - minutes;
  return (
    <>
      <CheckFigures purchase={entry.reason ?? formatMoney(entry.zar_paid)} zar={zar} balance={balance} minutes={minutes} />
      <p className="text-sm text-text-secondary">{quoted(flow.note)}</p>
      {after !== null && 0 > after ? <Alert tone="warning">{COPY.overdraws}</Alert> : null}
      <p className="text-sm text-text-muted">{COPY.revenueLine(zar)}</p>
      <p className="text-sm text-text-muted">{COPY.mailLine}</p>
    </>
  );
}

/** The note as the check says it back, in quotation marks. */
function quoted(note: string): string {
  return "\u201C" + note.trim() + "\u201D";
}

/** A balance, or a dash where it could not be read — never a zero standing in for it. */
function MaybeMinutes({ value }: { value: number | null }) {
  if (value === null) return <span>—</span>;
  return <Minutes value={value} />;
}

function CheckFigures({ purchase, zar, balance, minutes }: { purchase: string; zar: string; balance: number | null; minutes: number }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border bg-bg-muted p-4 text-sm">
      <dt className="text-text-secondary">{COPY.purchaseRow}</dt>
      <dd className="text-right text-text-primary">{purchase}</dd>
      <dt className="text-text-secondary">{COPY.zarRow}</dt>
      <dd className="text-right font-semibold tabular-nums text-text-primary">{zar}</dd>
      <div aria-hidden="true" className="col-span-2 my-1 h-px bg-border" />
      <dt className="text-text-secondary">{COPY.balanceNow}</dt>
      <dd className="text-right text-text-primary"><MaybeMinutes value={balance} /></dd>
      <dt className="text-text-secondary">{COPY.takenBack}</dt>
      <dd className="text-right text-text-primary"><Minutes value={-minutes} signed /></dd>
      <dt className="font-semibold text-text-primary">{COPY.balanceAfter}</dt>
      <dd className="text-right font-semibold text-text-primary"><MaybeMinutes value={balance === null ? null : balance - minutes} /></dd>
    </dl>
  );
}

function ReversalReceipt({ done }: { done: Receipt }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <AnimatedCheck size={48} className="text-success-strong" />
      <p className="text-lg font-semibold text-success-strong" role="status">{COPY.doneSentence(done.kind, formatMoney(done.zar), done.balanceAfter)}</p>
      {done.recovered ? <p className="max-w-prose text-sm text-text-secondary">{REVERSAL_LOST.landed}</p> : null}
      {done.zarLeft !== null && done.minutesLeft !== null && done.zarLeft > 0
        ? <p className="max-w-prose text-sm text-text-secondary">{COPY.receiptLeft(formatMoney(done.zarLeft), done.minutesLeft)}</p>
        : null}
      <p className="max-w-prose text-sm text-text-secondary">{COPY.mailLine}</p>
    </div>
  );
}

type FooterProps = { flow: Flow; guard: SendingGuard; press: ReturnType<typeof useReversalPress>; list: ListState; name: string };

function ReversalFooter({ flow, guard, press, list, name }: FooterProps) {
  const leave = () => guard.onOpenChange(false);
  if (flow.done) return <Button onClick={leave}>{COPY.done}</Button>;
  if (flow.step === 1) {
    return (
      <>
        <Button variant="outline" onClick={leave}>{COPY.cancel}</Button>
        <Button onClick={flow.toAmounts} disabled={list.status !== "ready"}>{COPY.next}</Button>
      </>
    );
  }
  if (flow.step === 2) {
    return (
      <>
        <Button variant="outline" onClick={() => flow.setStep(1)}>{COPY.back}</Button>
        <Button onClick={flow.toCheck}>{COPY.next}</Button>
      </>
    );
  }
  const zar = formatMoney(flow.zar ?? 0);
  return (
    <DeskConfirmFooter backLabel={COPY.back} onBack={() => flow.setStep(2)} busy={press.busy}>
      <ConfirmButton
        idleLabel={COPY.idleFor(flow.kind, zar)}
        cancelLabel={COPY.cancel}
        confirmLabel={COPY.confirmFor(flow.kind, name, zar, flow.minutes ?? 0)}
        ariaLabel={name}
        subject={name}
        tone="danger"
        disabled={press.busy}
        onConfirm={async () => {
          guard.setSending(true);
          try {
            return await press.press();
          } finally {
            guard.setSending(false);
          }
        }}
        className="min-h-touch w-full"
      />
    </DeskConfirmFooter>
  );
}
