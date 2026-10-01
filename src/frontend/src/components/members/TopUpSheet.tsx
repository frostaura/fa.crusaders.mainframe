import { useEffect, useState, type ReactNode } from "react";
import { Alert } from "@/components/Alert";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SendingNote, Stepper } from "@/components/bookings/SheetParts";
import { useSendingGuard, type SendingGuard } from "@/components/bookings/useSendingGuard";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { AnimatedCheck } from "@/components/ui/feedback-marks";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useIsSmUp } from "@/components/ui/use-media-query";
import { type AdjustReasonCode } from "@/lib/adminApi";
import { TOP_UP_SHEET as COPY, signedAmount } from "@/lib/membersCopy";
import {
  ADD_LINK, LIVE_PUSH_NOTE, LIVE_SAID, LOST_REPLY, MINUS_REFUSED, TAKE_BACK_CONSEQUENCE, TAKE_BACK_LINK,
  ZAR_RECEIVED, balanceSentence, confirmConsequence, countsAsRevenue, doneSentence, overdraftWarning,
  parseCredits, parseZar, reasonChoicesFor, reasonComplaints, reasonLabel, receiptHeader, revenueNote, sheetTitle,
  validateAmount, validateZar, type CreditDirection,
} from "@/lib/topUpCopy";
import { cn, formatCredits, formatMoney } from "@/lib/utils";
import { Minus, Plus } from "@/components/ui/icons";

/**
 * Add credit to a member, or take it back — two flows, never one signed field. (D3-B08, P5)
 *
 * <p>
 * <b>Three steps because money is three questions:</b> how much · why · is this right. The third
 * is not ceremony: the balance the member ends on is the only figure that tells a volunteer they
 * typed the number they meant, and before this it appeared solely in a four-second toast, after
 * the fact, over a row that had already changed.
 * </p>
 *
 * <p>
 * <b>A sheet, not a modal</b> (P5): from the right on a desktop, so the row it was opened from
 * stays in view; from the bottom on a phone, under the thumb. Presets are a toggle group beside
 * a free amount; the reason is a closed Select, because the code decides which ledger type the
 * movement posts and a typed one would not. Same mount-to-open contract as the modal it
 * replaces — the caller renders it to open it and `onClose` unmounts it — so every caller keeps
 * working unchanged.
 * </p>
 *
 * <p>
 * <b>Nothing here touches the idempotency machinery.</b> The key, the in-flight ref and the
 * double-click guard live with the caller (`useCreditAdjust`) and this component calls into them
 * rather than around them — a double-click once posted +7 twice, and four clicks on a slow
 * connection granted 44 credits where 11 were typed.
 * </p>
 */
type Applied = AppliedAdjustment;

/**
 * What a press settled on. `balanceAfterCredits` is null only where a lost reply was found on the
 * ledger and the balance could not be re-read; `recovered` says the reply was lost and the ledger
 * answered instead (review round 2, F3-2), so the receipt can say how it knows.
 */
export type AppliedAdjustment = { balanceAfterCredits: number | null; recovered?: boolean };

/**
 * What a press came to: a receipt, or `{ said }` — the line the confirm's live region speaks when
 * there is none (review round 3, I-6: it said "didn't go through" over an unknown outcome and over
 * a 409 that proved the movement landed) — or null for a refusal shown at a field.
 */
export type ApplyResult = AppliedAdjustment | { said: string } | null;

/** One complaint per field, so each is said at its own field (review round 3, A-4). */
type Complaints = { amount?: string; code?: string; detail?: string; zar?: string };

/**
 * The receipt, frozen at the press (F3.5): the balance BEFORE and the movement as they were when
 * the admin confirmed. The row's balance prop follows the server's answer, so a header worked
 * out from it read "has 250 · After +50: 300" above "now has 250".
 */
type Receipted = Applied & { before: number | null; amount: number };

export type TopUpSheetProps = {
  name: string;
  /** What the member has now, or null where the read failed. Null is NOT zero. */
  balance: number | null;
  busy: boolean;
  /** The one refusal that belongs at a field rather than in a banner. */
  bookingError: string | null;
  /** Signed: this component decides the sign from the DIRECTION — no field in the flow carries one. */
  onApply: (
    amountCredits: number, reasonCode: AdjustReasonCode, reason: string, zarReceived?: number,
  ) => Promise<ApplyResult>;
  onClose: () => void;
  /** The "for a booking" field, rendered on the reason step. */
  renderBookingField?: () => ReactNode;
};

const QUICK = [50, 100, 200, 500];

type Flow = ReturnType<typeof useTopUpFlow>;

function useTopUpFlow() {
  const [direction, setDirection] = useState<CreditDirection>("add");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amountText, setAmountText] = useState("");
  const [reasonCode, setReasonCode] = useState<AdjustReasonCode | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [zarText, setZarText] = useState("");
  const [complaints, setComplaints] = useState<Complaints>({});
  // Bumped by a Next that found a problem: the sheet then focuses the first invalid field.
  const [refused, setRefused] = useState(0);
  const [done, setDone] = useState<Receipted | null>(null);

  const valid = parseCredits(amountText);
  const asksZar = direction === "add" && reasonCode !== null && countsAsRevenue(reasonCode);
  const zar = asksZar ? parseZar(zarText) : null;

  /**
   * Switching direction resets the amount and the reason, deliberately: carrying "100" across
   * from "add" to "take back" is how a flow built to stop a sign mistake produces one.
   */
  const flip = () => {
    setDirection((d) => (d === "add" ? "take_back" : "add"));
    setAmountText("");
    setReasonCode(null);
    setReasonText("");
    setZarText("");
    setComplaints({});
    setStep(1);
  };

  const clear = (field: keyof Complaints) => setComplaints((c) => ({ ...c, [field]: undefined }));

  const typeAmount = (text: string) => {
    setAmountText(text);
    // Said at the moment it is typed: a refusal that waits for submit reads as a broken form.
    setComplaints(/^[-−]/.test(text.trim()) ? { amount: MINUS_REFUSED } : {});
  };

  const settle = (found: Complaints, next: 2 | 3) => {
    setComplaints(found);
    if (Object.values(found).some(Boolean)) setRefused((n) => n + 1);
    else setStep(next);
  };

  const toReason = () => settle({ amount: validateAmount(amountText) ?? undefined }, 2);

  /** Every field's own complaint at once, each at its own field — not the first one under the last field. */
  const toCheck = () => settle({
    ...reasonComplaints(reasonCode, reasonText),
    zar: asksZar ? validateZar(zarText) ?? undefined : undefined,
  }, 3);

  const back = (to: 1 | 2) => { setComplaints({}); setStep(to); };

  return {
    direction, step, back, amountText, typeAmount, reasonCode, setReasonCode, reasonText, setReasonText,
    zarText, setZarText, asksZar, zar, complaints, clear, refused, done, setDone, valid, flip, toReason, toCheck,
  };
}

/**
 * R5 I5-3: every way out — ×, Escape, the scrim, Cancel — asks the sending guard first, so the
 * sheet cannot close while a credit is on its way; the footer says it is waiting, again on each
 * refused close. A sheet opened while an earlier movement is still in flight (`busy` from the
 * caller) says why its Add waits rather than showing a disabled button with no reason.
 */
export function TopUpSheet(props: TopUpSheetProps) {
  const { name, onClose } = props;
  const wide = useIsSmUp();
  const flow = useTopUpFlow();
  const guard = useSendingGuard((open) => { if (!open) onClose(); });
  useFocusFirstInvalid(flow.refused);
  return (
    <Sheet open onOpenChange={guard.onOpenChange}>
      <SheetContent side={wide ? "right" : "bottom"} data-sheet="top-up">
        <SheetHeader>
          <SheetTitle>{sheetTitle(flow.direction, name)}</SheetTitle>
          <SheetDescription>
            {flow.done
              ? receiptHeader(name, flow.done.before, flow.done.amount, flow.direction)
              : balanceSentence(name, props.balance, flow.valid, flow.direction)}
          </SheetDescription>
          {flow.done ? null : <Stepper names={COPY.steps} current={flow.step - 1} />}
        </SheetHeader>
        <SheetBody className="flex flex-col gap-4 pb-4">
          <StepBody flow={flow} {...props} />
        </SheetBody>
        {/* The check step stacks on every width (F3-14): beside Back, the armed confirm — a
            sentence over two buttons — had a third of a narrow sheet and "Add 200.00 cr" wrapped.
            Stacked, BOTH rows run the sheet's width (R3 V-3): the primary was left at its own
            width under a full-width Back. */}
        <SheetFooter className={cn("sm:items-end", flow.step === 3 && !flow.done && "sm:flex-col sm:items-stretch")}>
          <SendingNote text={props.busy ? COPY.sending(name) : null} refused={guard.refused} />
          <StepFooter flow={flow} guard={guard} {...props} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function StepBody({ flow, ...props }: TopUpSheetProps & { flow: Flow }) {
  if (flow.done) return <Receipt name={props.name} done={flow.done} />;
  if (flow.step === 1) return <AmountStep flow={flow} balance={props.balance} />;
  if (flow.step === 2) return <ReasonStep flow={flow} bookingError={props.bookingError} renderBookingField={props.renderBookingField} />;
  return <CheckStep flow={flow} balance={props.balance} bookingError={props.bookingError} />;
}

/**
 * The other direction is an action, not navigation — a button, low in the flow and differently
 * titled, because a sign is a character somebody types and not a decision they make.
 */
function AmountStep({ flow, balance }: { flow: Flow; balance: number | null }) {
  const preset = QUICK.map(String).includes(flow.amountText.trim()) ? flow.amountText.trim() : "";
  const warning = flow.direction === "take_back" ? overdraftWarning(balance, flow.valid) : null;
  const flipIcon = flow.direction === "add" ? <Minus aria-hidden="true" /> : <Plus aria-hidden="true" />;
  return (
    <>
      <ToggleGroup
        type="single"
        variant="outline"
        size="lg"
        aria-label={COPY.quickLabel}
        value={preset}
        onValueChange={(value) => flow.typeAmount(value)}
        className="grid w-full grid-cols-2 gap-2"
      >
        {QUICK.map((value) => (
          <ToggleGroupItem key={value} value={String(value)} className="tabular-nums">
            {signedAmount(flow.direction, value)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Field>
        <FieldLabel>{COPY.amountLabel}</FieldLabel>
        <Input
          inputMode="decimal"
          autoComplete="off"
          value={flow.amountText}
          placeholder={COPY.amountPlaceholder}
          onChange={(e) => flow.typeAmount(e.target.value)}
        />
        <FieldError>{flow.complaints.amount}</FieldError>
      </Field>
      {warning ? <Alert tone="warning" live="polite">{warning}</Alert> : null}
      {/* A button that looks like one (VIS F3-15): as a ghost it read as a line of text. */}
      <Button variant="outline" className="self-start" onClick={flow.flip} icon={flipIcon}>
        {flow.direction === "add" ? TAKE_BACK_LINK : ADD_LINK}
      </Button>
    </>
  );
}

function ReasonStep({ flow, bookingError, renderBookingField }: {
  flow: Flow; bookingError: string | null; renderBookingField?: () => ReactNode;
}) {
  const { complaints } = flow;
  return (
    <>
      <Field>
        <FieldLabel>{COPY.reasonLabel}</FieldLabel>
        <Select
          value={flow.reasonCode ?? ""}
          onValueChange={(code) => { flow.setReasonCode(code as AdjustReasonCode); flow.clear("code"); }}
        >
          <SelectTrigger>
            <SelectValue placeholder={COPY.reasonPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {reasonChoicesFor(flow.direction).map((choice) => (
              <SelectItem key={choice.code} value={choice.code}>{choice.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          {flow.reasonCode ? `${COPY.reasonDescription} ${revenueNote(flow.reasonCode, flow.zar)}` : COPY.reasonDescription}
        </FieldDescription>
        <FieldError>{complaints.code}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{COPY.detailLabel}</FieldLabel>
        <Input
          autoComplete="off"
          value={flow.reasonText}
          placeholder={COPY.detailPlaceholder}
          onChange={(e) => { flow.setReasonText(e.target.value); flow.clear("detail"); }}
        />
        <FieldError>{complaints.detail}</FieldError>
      </Field>
      {flow.asksZar ? (
        <Field>
          <FieldLabel>{ZAR_RECEIVED.label}</FieldLabel>
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={flow.zarText}
            placeholder={ZAR_RECEIVED.placeholder}
            onChange={(e) => { flow.setZarText(e.target.value); flow.clear("zar"); }}
          />
          <FieldDescription>{ZAR_RECEIVED.help}</FieldDescription>
          <FieldError>{complaints.zar}</FieldError>
        </Field>
      ) : null}
      {renderBookingField?.()}
      {bookingError ? <Alert tone="danger">{bookingError}</Alert> : null}
    </>
  );
}

function CheckStep({ flow, balance, bookingError }: { flow: Flow; balance: number | null; bookingError: string | null }) {
  if (flow.valid === null || flow.reasonCode === null) return null;
  const signed = flow.direction === "add" ? flow.valid : -flow.valid;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border bg-bg-muted p-4 text-sm">
        <dt className="text-text-secondary">{COPY.balanceNow}</dt>
        <dd className="text-right tabular-nums text-text-primary">{balance === null ? COPY.unreadable : formatCredits(balance)}</dd>
        <dt className="text-text-secondary">{COPY.thisMovement}</dt>
        <dd className="text-right font-semibold tabular-nums text-text-primary">{signedAmount(flow.direction, flow.valid)}</dd>
        <div aria-hidden="true" className="col-span-2 my-1 h-px bg-border" />
        <dt className="font-semibold text-text-primary">{COPY.balanceAfter}</dt>
        <dd className="text-right font-semibold tabular-nums text-text-primary">
          {balance === null ? COPY.serverWorksItOut : formatCredits(balance + signed)}
        </dd>
        {flow.zar !== null ? (
          <>
            <dt className="text-text-secondary">{ZAR_RECEIVED.row}</dt>
            <dd className="text-right tabular-nums text-text-primary">{formatMoney(flow.zar)}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm text-text-secondary">{COPY.reasonLine(reasonLabel(flow.reasonCode), flow.reasonText.trim())}</p>
      <p className="text-sm text-text-muted">{revenueNote(flow.reasonCode, flow.zar)}</p>
      {flow.direction === "take_back" ? <p className="text-sm text-warning-strong">{TAKE_BACK_CONSEQUENCE}</p> : null}
      <p className="text-sm text-text-muted">{LIVE_PUSH_NOTE}</p>
      {bookingError ? <Alert tone="danger">{bookingError}</Alert> : null}
    </>
  );
}

/** The receipt STAYS: money deserves more than a toast, and the figure to check is the one after. */
function Receipt({ name, done }: { name: string; done: Applied }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <AnimatedCheck size={48} className="text-success-strong" />
      <p className="text-lg font-semibold text-success-strong" role="status">{doneSentence(name, done.balanceAfterCredits)}</p>
      {done.recovered ? <p className="max-w-prose text-sm text-text-secondary">{LOST_REPLY.landed}</p> : null}
      <p className="max-w-prose text-sm text-text-secondary">{LIVE_PUSH_NOTE}</p>
    </div>
  );
}

type FooterProps = TopUpSheetProps & { flow: Flow; guard: SendingGuard };

function StepFooter({ flow, guard, ...props }: FooterProps) {
  const leave = () => guard.onOpenChange(false);
  if (flow.done) return <Button onClick={leave}>{COPY.done}</Button>;
  if (flow.step === 1) {
    return (
      <>
        <Button variant="outline" onClick={leave}>{COPY.cancel}</Button>
        <Button onClick={flow.toReason}>{COPY.next}</Button>
      </>
    );
  }
  if (flow.step === 2) {
    return (
      <>
        <Button variant="outline" onClick={() => flow.back(1)}>{COPY.back}</Button>
        <Button onClick={flow.toCheck}>{COPY.next}</Button>
      </>
    );
  }
  return <ApplyControls flow={flow} guard={guard} {...props} />;
}

function ApplyControls({ flow, guard, name, balance, busy, onApply }: FooterProps) {
  const { valid, reasonCode, direction } = flow;
  if (valid === null || reasonCode === null) return null;
  return (
    <>
      {/* Back while the credit is on its way would drop the receipt it lands on (R5 I5-3). */}
      <Button variant="outline" disabled={busy} onClick={() => flow.back(2)}>{COPY.back}</Button>
      {/* Its own full-width row (F3.23, F3-14): armed, the confirm is a sentence over two buttons.
          `w-full` on the idle button too (R3 V-3, A-15): at its own width "Add 50.00 cr" wrapped. */}
      <div className="min-w-0">
        <ConfirmButton
          idleLabel={direction === "add" ? `Add ${formatCredits(valid)}` : `Take back ${formatCredits(valid)}`}
          cancelLabel={COPY.cancel}
          confirmLabel={confirmConsequence(name, balance, valid, direction)}
          // `ariaLabel` is what the ACTION is about ("Add 24.00 cr — Thandi Mokoena — choose again
          // to confirm"); `subject` is what the way OUT names ("Cancel — Thandi Mokoena").
          ariaLabel={name}
          subject={name}
          tone={direction === "add" ? "info" : "danger"}
          // The one primary on the sheet: taking credit back keeps the danger-soft look.
          idleClassName={direction === "add" ? buttonVariants({ variant: "primary" }) : undefined}
          disabled={busy}
          onConfirm={async () => {
            const before = balance;
            // Set here, at the press, not from `busy`: that prop commits a render later, and an
            // Escape in between closed the sheet over a credit already sent (R5 I5-3).
            guard.setSending(true);
            let applied: ApplyResult;
            try {
              applied = await onApply(
                direction === "add" ? valid : -valid, reasonCode, flow.reasonText.trim(), flow.zar ?? undefined,
              );
            } finally {
              guard.setSending(false);
            }
            if (!applied) return LIVE_SAID.refused;
            if ("said" in applied) return applied.said;
            flow.setDone({ ...applied, before, amount: valid });
            return doneSentence(name, applied.balanceAfterCredits);
          }}
          className="min-h-touch w-full"
        />
      </div>
    </>
  );
}

/**
 * After a Next that found a problem, focus the FIRST field that has one (review round 3, A-4):
 * the complaints are said at their fields, and the keyboard goes to where the fixing starts.
 * After the render, because the field's `aria-invalid` is what marks it.
 */
function useFocusFirstInvalid(refused: number) {
  useEffect(() => {
    if (refused === 0) return;
    const frame = requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[data-sheet='top-up'] [aria-invalid='true']")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [refused]);
}
