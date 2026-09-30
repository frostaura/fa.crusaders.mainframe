import { useState, type ReactNode } from "react";
import { Alert } from "@/components/Alert";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Stepper } from "@/components/bookings/SheetParts";
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
  ADD_LINK, LIVE_PUSH_NOTE, LOST_REPLY, MINUS_REFUSED, TAKE_BACK_CONSEQUENCE, TAKE_BACK_LINK,
  ZAR_RECEIVED, balanceSentence, confirmConsequence, countsAsRevenue, doneSentence, overdraftWarning,
  parseCredits, parseZar, reasonChoicesFor, reasonLabel, receiptHeader, revenueNote, sheetTitle, validateAmount,
  validateReason, validateZar, type CreditDirection,
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
  ) => Promise<Applied | null>;
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
  const [complaint, setComplaint] = useState<string | null>(null);
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
    setComplaint(null);
    setStep(1);
  };

  const typeAmount = (text: string) => {
    setAmountText(text);
    // Said at the moment it is typed: a refusal that waits for submit reads as a broken form.
    setComplaint(/^[-−]/.test(text.trim()) ? MINUS_REFUSED : null);
  };

  const toReason = () => {
    const said = validateAmount(amountText);
    setComplaint(said);
    if (!said) setStep(2);
  };

  const toCheck = () => {
    const said = validateReason(reasonCode, reasonText) ?? (asksZar ? validateZar(zarText) : null);
    setComplaint(said);
    if (!said) setStep(3);
  };

  return {
    direction, step, setStep, amountText, typeAmount, reasonCode, setReasonCode, reasonText, setReasonText,
    zarText, setZarText, asksZar, zar, complaint, setComplaint, done, setDone, valid, flip, toReason, toCheck,
  };
}

export function TopUpSheet(props: TopUpSheetProps) {
  const { name, onClose } = props;
  const wide = useIsSmUp();
  const flow = useTopUpFlow();
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
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
            sentence over two buttons — had a third of a narrow sheet and "Add 200.00 cr" wrapped. */}
        <SheetFooter className={cn("sm:items-end", flow.step === 3 && !flow.done && "sm:flex-col sm:items-stretch")}>
          <StepFooter flow={flow} {...props} />
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
        <FieldError>{flow.complaint}</FieldError>
      </Field>
      {warning ? <Alert tone="warning" live="polite">{warning}</Alert> : null}
      {/* A button that looks like one (VIS F3-15): as a ghost it read as a line of text. */}
      <Button
        variant="outline"
        className="self-start"
        icon={flow.direction === "add" ? <Minus aria-hidden="true" /> : <Plus aria-hidden="true" />}
        onClick={flow.flip}
      >
        {flow.direction === "add" ? TAKE_BACK_LINK : ADD_LINK}
      </Button>
    </>
  );
}

function ReasonStep({ flow, bookingError, renderBookingField }: {
  flow: Flow; bookingError: string | null; renderBookingField?: () => ReactNode;
}) {
  const missingCode = flow.complaint !== null && flow.reasonCode === null;
  return (
    <>
      <Field>
        <FieldLabel>{COPY.reasonLabel}</FieldLabel>
        <Select
          value={flow.reasonCode ?? ""}
          onValueChange={(code) => { flow.setReasonCode(code as AdjustReasonCode); flow.setComplaint(null); }}
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
        <FieldError>{missingCode ? flow.complaint : null}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{COPY.detailLabel}</FieldLabel>
        <Input
          autoComplete="off"
          value={flow.reasonText}
          placeholder={COPY.detailPlaceholder}
          onChange={(e) => { flow.setReasonText(e.target.value); flow.setComplaint(null); }}
        />
        <FieldError>{missingCode || flow.asksZar ? null : flow.complaint}</FieldError>
      </Field>
      {flow.asksZar ? (
        <Field>
          <FieldLabel>{ZAR_RECEIVED.label}</FieldLabel>
          <Input
            inputMode="decimal"
            autoComplete="off"
            value={flow.zarText}
            placeholder={ZAR_RECEIVED.placeholder}
            onChange={(e) => { flow.setZarText(e.target.value); flow.setComplaint(null); }}
          />
          <FieldDescription>{ZAR_RECEIVED.help}</FieldDescription>
          <FieldError>{missingCode ? null : flow.complaint}</FieldError>
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

function StepFooter({ flow, ...props }: TopUpSheetProps & { flow: Flow }) {
  if (flow.done) return <Button onClick={props.onClose}>{COPY.done}</Button>;
  if (flow.step === 1) {
    return (
      <>
        <Button variant="outline" onClick={props.onClose}>{COPY.cancel}</Button>
        <Button onClick={flow.toReason}>{COPY.next}</Button>
      </>
    );
  }
  if (flow.step === 2) {
    return (
      <>
        <Button variant="outline" onClick={() => { flow.setComplaint(null); flow.setStep(1); }}>{COPY.back}</Button>
        <Button onClick={flow.toCheck}>{COPY.next}</Button>
      </>
    );
  }
  return <ApplyControls flow={flow} {...props} />;
}

function ApplyControls({ flow, name, balance, busy, onApply }: TopUpSheetProps & { flow: Flow }) {
  const { valid, reasonCode, direction } = flow;
  if (valid === null || reasonCode === null) return null;
  return (
    <>
      <Button variant="outline" onClick={() => flow.setStep(2)}>{COPY.back}</Button>
      {/* Its own full-width row (F3.23, F3-14): armed, the confirm is a sentence over two buttons. */}
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
            const applied = await onApply(
              direction === "add" ? valid : -valid, reasonCode, flow.reasonText.trim(), flow.zar ?? undefined,
            );
            if (!applied) return COPY.failed;
            flow.setDone({ ...applied, before, amount: valid });
            return doneSentence(name, applied.balanceAfterCredits);
          }}
          className="min-h-touch"
        />
      </div>
    </>
  );
}
