import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Minutes } from "@/components/Minutes";
import { SendingNote, Stepper } from "@/components/bookings/SheetParts";
import { useSendingGuard, type SendingGuard } from "@/components/bookings/useSendingGuard";
import { useToast } from "@/components/Toast";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { AnimatedCheck } from "@/components/ui/feedback-marks";
import { HourglassMedium } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RadioCard, RadioGroup } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StateBlock } from "@/components/ui/state-block";
import { useIsSmUp } from "@/components/ui/use-media-query";
import type { MemberShelf, ShelfPackage } from "@/lib/api";
import { adminEndpoints, type SellReasonCode } from "@/lib/adminApi";
import {
  LIVE_PUSH_NOTE, LIVE_SAID, LOST_REPLY, PAYMENT_CHOICES, REASON_MISSING, SELL_COPY as COPY, doneSentence,
  parseZar, percentOfBps, reasonLabel, validateZar, zarField,
} from "@/lib/deskMinutesCopy";
import { formatMoney } from "@/lib/utils";
import type { AdjustmentKey } from "./adjustmentAttempt";
import { attemptSale, type ShelfDiscount } from "./sellAttempt";
import { useMenuReturnFocus } from "./useMenuReturnFocus";
import { useStepFocus } from "./useStepFocus";
import { focusFirstComplaint, settleOnSell } from "./saleFocus";
import { shelfSections } from "@/lib/topUpShelf";

/**
 * Sell a member a package at the desk (P13 §3.7) — how the club takes cash, EFT or a card
 * offline. Three steps, because money is three questions: which package · how was it paid ·
 * is this right.
 *
 * <p>
 * <b>The member's own shelf, read for them</b> (`GET /admin/minutes/{id}/packages`): their groups'
 * packages and the club's at their discount, priced exactly as the app would price them, so the
 * desk can never sell something the member could not have bought. The money received defaults to
 * that price and may differ (a regular rounding to a note) — the revenue report shows what the
 * desk says it took.
 * </p>
 *
 * <p>
 * <b>The same press discipline as an adjustment</b>: a ref stops the double-click, a key names the
 * sale so a retry replays rather than sells twice, a lost reply is looked up on the ledger
 * (`sellAttempt`), and the sheet cannot close while a sale is on its way (R5 I5-3).
 * </p>
 */
export type SellPackageSheetProps = {
  userId: string;
  name: string;
  /** What the member has now, or null where the read failed. Null is NOT zero. */
  balance: number | null;
  onClose: () => void;
  /** The server's balance after a sale, or null where a lost reply's re-read failed too. */
  onSold: (balanceAfter: number | null) => void;
  /** X6-1: where focus goes when the sheet was opened from a ⋯ menu — that ⋯ (`useMenuReturnFocus`). */
  returnFocus?: () => HTMLElement | null | undefined;
};

type ShelfState = { status: "loading" } | { status: "failed"; error: unknown } | { status: "ready"; shelf: MemberShelf };
type Complaints = { pkg?: string; code?: string; detail?: string; zar?: string };
type Receipt = { pkg: ShelfPackage; balanceAfter: number | null; recovered: boolean; free: boolean };

/** The shelf with `pkg` in it at the price given — replacing its namesake, or kept when a re-read dropped it. */
function withPackage(shelf: MemberShelf, pkg: ShelfPackage): MemberShelf {
  const found = shelf.packages.some((p) => p.id === pkg.id);
  return { ...shelf, packages: found ? shelf.packages.map((p) => (p.id === pkg.id ? pkg : p)) : [...shelf.packages, pkg] };
}

function useShelf(userId: string) {
  const [state, setState] = useState<ShelfState>({ status: "loading" });
  /** Bumped by every read and every 409: a quiet re-read that a newer answer overtook is dropped. */
  const epoch = useRef(0);
  const read = useCallback(async () => {
    epoch.current += 1;
    setState({ status: "loading" });
    try {
      setState({ status: "ready", shelf: await adminEndpoints.memberShelf(userId) });
    } catch (error) {
      setState({ status: "failed", error });
    }
  }, [userId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void read(); }, [read]);
  /**
   * R9 J9-1 / R10 J10-1: a 409 `package_price_changed` says the package's price AND the member's
   * discount now. Both go on the sheet at once — the header's "N% off" moved with the price
   * ("20% off" over a 10% price, "100% off" asking R120) — and then the WHOLE shelf is read again,
   * quietly, so Back lists every package at its price now (R8 J8-2's rule for the member's own
   * shelf). The chosen package keeps the price the 409 named: the server judges the next press,
   * and a second move answers with a second 409, never a sale at a figure nobody saw.
   */
  const apply = useCallback((pkg: ShelfPackage, discount: ShelfDiscount | undefined) => {
    epoch.current += 1;
    const seen = epoch.current;
    setState((now) => (now.status === "ready"
      ? { status: "ready", shelf: withPackage(discount === undefined ? now.shelf : { ...now.shelf, discount }, pkg) }
      : now));
    void adminEndpoints.memberShelf(userId).then((fresh) => {
      if (epoch.current !== seen) return;
      setState((now) => (now.status === "ready" ? { status: "ready", shelf: withPackage(fresh, pkg) } : now));
    }, () => {
      // The 409's own facts stand; Back shows the other packages as last read.
    });
  }, [userId]);
  return { state, read, apply };
}

/** R10 X10-2 / J10-4: what the sheet says after a price moved, and whether it says it itself. */
type Notice = {
  text: string;
  /**
   * True when the step changed under it (a gift that now costs money goes back to the payment
   * questions): the Sell button that would have said it is gone, so the notice speaks — once.
   * False on the check: the Sell button's own live region says it, so the notice stays silent.
   */
  speaks: boolean;
};

function useSaleFlow(shelf: ShelfState) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [pkgId, setPkgId] = useState<string | null>(null);
  const [code, setCode] = useState<SellReasonCode | null>(null);
  const [detail, setDetail] = useState("");
  const [zarText, setZarText] = useState("");
  const [complaints, setComplaints] = useState<Complaints>({});
  const [done, setDone] = useState<Receipt | null>(null);
  /** R9 J9-1: the price moved under the desk — said in the sheet until the admin chooses again. */
  const [notice, setNotice] = useState<Notice | null>(null);
  /** R10 X10-3: bumped by a Next that found a problem — the sheet then focuses the first one. */
  const [refused, setRefused] = useState(0);
  const pkg = shelf.status === "ready" ? shelf.shelf.packages.find((p) => p.id === pkgId) ?? null : null;

  /** Choosing a package starts the money received at its price for THIS member. */
  const choose = (id: string) => {
    setPkgId(id);
    const chosen = shelf.status === "ready" ? shelf.shelf.packages.find((p) => p.id === id) : undefined;
    if (chosen) setZarText(zarField(chosen.price_zar));
    setComplaints({});
    setNotice(null);
  };
  const settle = (found: Complaints, next: 2 | 3) => {
    setComplaints(found);
    if (Object.values(found).some(Boolean)) setRefused((n) => n + 1);
    else setStep(next);
  };
  const toPayment = () => settle({ pkg: pkg ? undefined : COPY.pickPackage }, 2);
  // R7 J7-10: a package that costs this member nothing asks no payment questions at all.
  const free = pkg !== null && isFree(pkg);
  const toCheck = () => settle({
    // R7 J7-6: said under "How was it paid?", so it names the payment.
    code: !free && code === null ? COPY.paymentMissing : undefined,
    detail: detail.trim() ? undefined : REASON_MISSING.detail,
    zar: free ? undefined : validateZar(zarText) ?? undefined,
  }, 3);
  /** Back to the shelf after a refusal said it changed: nothing chosen survives a re-read. */
  const restart = () => { setPkgId(null); setStep(1); setComplaints({}); setNotice(null); };
  /**
   * R9 J9-1: the price is not what was confirmed. The money received follows it when it was still
   * the old price (the default); a figure the admin typed is theirs. A gift that now costs money
   * goes back to the payment questions it never asked; otherwise the check is shown again.
   */
  const reprice = (was: ShelfPackage, now: ShelfPackage, said: string) => {
    if (parseZar(zarText) === was.price_zar || isFree(was)) setZarText(zarField(now.price_zar));
    const toPayment = isFree(was) && !isFree(now);
    setNotice({ text: said, speaks: toPayment });
    setStep(toPayment ? 2 : 3);
  };
  return {
    step, setStep, pkg, choose, code, setCode, detail, setDetail, zarText, setZarText, complaints, setComplaints,
    done, setDone, toPayment, toCheck, restart, free, zar: free ? 0 : parseZar(zarText), notice, reprice, refused,
  };
}

type Flow = ReturnType<typeof useSaleFlow>;

/** R7 J7-10: THIS member's price for it is R0.00 (a 100% discount) — given, not sold. */
function isFree(pkg: ShelfPackage): boolean {
  return pkg.price_zar === 0;
}

/**
 * The `/sell` code: how the desk was paid, or — for a package that costs the member nothing —
 * `package_free` (integrator's call, R7 J7-10: valid only when their shelf price is R0.00), so a
 * gift never sits on the ledger as "Cash paid at the desk".
 */
function saleCode(flow: Flow): SellReasonCode | null {
  if (flow.free) return "package_free";
  return flow.code;
}

/** The press: one in flight at a time, under a key that names this sale. */
function useSalePress(props: SellPackageSheetProps, flow: Flow, shelf: ReturnType<typeof useShelf>) {
  const toast = useToast();
  const key = useRef<AdjustmentKey>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const press = async (): Promise<string> => {
    const { pkg, zar } = flow;
    const code = saleCode(flow);
    if (!pkg || code === null || inFlight.current) return LIVE_SAID.refused;
    inFlight.current = true;
    setBusy(true);
    try {
      // R9 J9-1: always the price the check showed AND the rand taken — the server never prices a
      // sale, so a discount that moves after Check is refused, not recorded at a figure nobody saw.
      const zarReceived = flow.free ? 0 : zar ?? pkg.price_zar;
      const outcome = await attemptSale({
        userId: props.userId, pkg, reasonCode: code, reason: flow.detail, quotedPriceZar: pkg.price_zar, zarReceived, name: props.name,
      }, key);
      return settleOutcome(outcome, { props, flow, toast, shelf });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, press };
}

type Settle = {
  props: SellPackageSheetProps; flow: Flow; toast: ReturnType<typeof useToast>; shelf: ReturnType<typeof useShelf>;
};

function settleOutcome(outcome: Awaited<ReturnType<typeof attemptSale>>, ctx: Settle): string {
  const { props, flow, toast, shelf } = ctx;
  if (outcome.kind === "unavailable") {
    toast.push({ tone: "danger", text: outcome.message, unchanged: true, durationMs: 8000 });
    flow.restart();
    void shelf.read();
    return outcome.message;
  }
  if (outcome.kind === "repriced") return repriced(outcome.pkg, outcome.discount, ctx);
  if (outcome.kind === "failed") {
    toast.push({ tone: "danger", text: outcome.message, unchanged: outcome.unchanged, durationMs: 8000 });
    if (outcome.balanceNow !== undefined) props.onSold(outcome.balanceNow);
    return outcome.said;
  }
  props.onSold(outcome.balanceAfterMinutes);
  flow.setDone({ pkg: flow.pkg!, balanceAfter: outcome.balanceAfterMinutes, recovered: outcome.recovered, free: flow.free });
  return doneSentence(props.name, outcome.balanceAfterMinutes);
}

/**
 * R9 J9-1: 409 `package_price_changed` — nothing recorded. The package takes the price the server
 * sent (or the shelf is read again when the body had none) and the sheet says what changed; the
 * admin confirms again at the new price. Never a danger toast: nothing failed, the price moved.
 */
function repriced(fresh: ShelfPackage | null, discount: ShelfDiscount | undefined, ctx: Settle): string {
  const { flow, shelf } = ctx;
  const was = flow.pkg!;
  if (!fresh) {
    flow.restart();
    void shelf.read();
    return COPY.unavailable;
  }
  const said = isFree(was) && !isFree(fresh)
    ? COPY.noLongerFree(ctx.props.name, formatMoney(fresh.price_zar))
    : COPY.priceChanged(formatMoney(fresh.price_zar), formatMoney(was.price_zar));
  shelf.apply(fresh, discount);
  flow.reprice(was, fresh, said);
  return said;
}

export function SellPackageSheet(props: SellPackageSheetProps) {
  const { name, onClose } = props;
  const wide = useIsSmUp();
  const shelf = useShelf(props.userId);
  const flow = useSaleFlow(shelf.state);
  const sale = useSalePress(props, flow, shelf);
  const guard = useSendingGuard((open) => { if (!open) onClose(); });
  const backToMenu = useMenuReturnFocus(props.returnFocus);
  const [stepRef, stepLabel] = useStepFocus(flow.step, COPY.steps, flow.done !== null);
  useNoticeArrival(flow.notice);
  useComplaintFocus(flow.refused);
  return (
    <Sheet open onOpenChange={guard.onOpenChange}>
      <SheetContent side={wide ? "right" : "bottom"} data-sheet="sell-package" onCloseAutoFocus={backToMenu}>
        <SheetHeader>
          <SheetTitle>{COPY.titleFor(name, flow.free)}</SheetTitle>
          <SheetDescription>{shelfLine(shelf.state)}</SheetDescription>
          {flow.done ? null : <Stepper names={COPY.steps} current={flow.step - 1} />}
        </SheetHeader>
        <SheetBody ref={stepRef} tabIndex={-1} role="group" aria-label={stepLabel} className="flex flex-col gap-4 pb-4 outline-none">
          {/* R10 X10-2: said ONCE — by the Sell button's live region on the check, by itself when the step changed. */}
          {flow.notice && !flow.done ? (
            <div data-sale-notice="">
              <Alert tone="warning" live={flow.notice.speaks ? "standing" : "off"} announceKey={flow.notice.text}>{flow.notice.text}</Alert>
            </div>
          ) : null}
          <SaleBody flow={flow} shelf={shelf} balance={props.balance} name={name} />
        </SheetBody>
        <SheetFooter className="sm:items-end">
          <SendingNote text={sale.busy ? COPY.sending(name) : null} refused={guard.refused} />
          <SaleFooter flow={flow} guard={guard} sale={sale} shelf={shelf.state} name={name} />
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * R10 J10-4 / X10-2: a price that moved is SEEN — the notice is brought into view (at 390 px and
 * 200 % text it sat above the fold while "Money received" changed under the admin) — and the
 * keyboard lands on Sell, the press that answers it, never on the dialog container the closing
 * confirm left it on. When the step changed instead, `useStepFocus` takes focus to the new step.
 */
function useNoticeArrival(notice: Notice | null) {
  useEffect(() => {
    if (!notice) return undefined;
    document.querySelector<HTMLElement>("[data-sheet='sell-package'] [data-sale-notice]")?.scrollIntoView?.({ block: "nearest" });
    return notice.speaks ? undefined : settleOnSell("[data-sheet='sell-package']");
  }, [notice]);
}

/** R10 X10-3: a Next that found a problem takes the keyboard to the first one, as Adjust minutes does. */
function useComplaintFocus(refused: number) {
  useEffect(() => {
    if (refused === 0) return undefined;
    const frame = requestAnimationFrame(() => focusFirstComplaint("[data-sheet='sell-package']"));
    return () => cancelAnimationFrame(frame);
  }, [refused]);
}

/** The member's discount, said once under the title: it is why the prices below are what they are. */
function shelfLine(state: ShelfState): string {
  if (state.status !== "ready" || !state.shelf.discount) return COPY.shelfHint;
  const { bps, group } = state.shelf.discount;
  return `${COPY.shelfHint} ${COPY.discountLine(percentOfBps(bps), group.name)}`;
}

type BodyProps = { flow: Flow; shelf: ReturnType<typeof useShelf>; balance: number | null; name: string };

function SaleBody({ flow, shelf, balance, name }: BodyProps) {
  if (flow.done) return <SaleReceipt name={name} done={flow.done} />;
  if (flow.step === 2 && flow.pkg) return flow.free ? <FreeStep flow={flow} /> : <PaymentStep flow={flow} pkg={flow.pkg} />;
  if (flow.step === 3 && flow.pkg) return <SaleCheck flow={flow} pkg={flow.pkg} balance={balance} />;
  const state = shelf.state;
  return (
    <StateBlock
      loading={state.status === "loading"}
      error={state.status === "failed" ? state.error : null}
      action={COPY.shelfAction}
      onRetry={() => void shelf.read()}
      empty={state.status === "ready" && state.shelf.packages.length === 0}
      emptyTitle={COPY.shelfEmptyTitle}
      emptyHint={COPY.shelfEmptyHint}
      emptyIcon={HourglassMedium}
      emptyAction={<Link className={buttonVariants({ variant: "outline" })} to="/admin/packages">{COPY.shelfEmptyAction}</Link>}
      skeleton={<ShelfSkeleton />}
    >
      {state.status === "ready" ? <ShelfChoice flow={flow} packages={state.shelf.packages} name={name} /> : null}
    </StateBlock>
  );
}

function ShelfSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2].map((row) => <Skeleton key={row} className="h-16 w-full" />)}
    </div>
  );
}

/** Each package a card: its name, its minutes, what THIS member pays, and what it saves. */
function ShelfChoice({ flow, packages, name }: { flow: Flow; packages: ShelfPackage[]; name: string }) {
  const errorId = useId();
  const complaint = flow.complaints.pkg;
  return (
    <Field>
      <FieldLabel>{COPY.shelfLabel(name)}</FieldLabel>
      {/* R10 X10-3: the group carries its complaint, so focus landing in it hears what is missing. */}
      <RadioGroup
        value={flow.pkg?.id ?? ""}
        onValueChange={flow.choose}
        aria-label={COPY.shelfLabel(name)}
        aria-invalid={complaint ? true : undefined}
        aria-describedby={complaint ? errorId : undefined}
      >
        {/* J6-4: in the member's own order — their groups' packages first, then the club's. */}
        {shelfSections(packages).flatMap((section) => section.packages).map((p) => (
          <RadioCard key={p.id} value={p.id} title={<PackageTitle pkg={p} />} description={<PackageLine pkg={p} />} />
        ))}
      </RadioGroup>
      <FieldError id={errorId}>{complaint}</FieldError>
    </Field>
  );
}

function PackageTitle({ pkg }: { pkg: ShelfPackage }) {
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span>{pkg.name}</span>
      <span className="font-semibold tabular-nums">{formatMoney(pkg.price_zar)}</span>
    </span>
  );
}

function PackageLine({ pkg }: { pkg: ShelfPackage }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Minutes value={pkg.minutes} />
      {pkg.discount_bps > 0 ? <span className="tabular-nums line-through">{COPY.listPrice(formatMoney(pkg.list_price_zar))}</span> : null}
      {pkg.saving_zar ? <Badge tone="success">{COPY.saving(formatMoney(pkg.saving_zar), pkg.saving_pct)}</Badge> : null}
      {pkg.group ? <Badge tone="neutral">{COPY.fromGroup(pkg.group.name)}</Badge> : null}
    </span>
  );
}

function PaymentStep({ flow, pkg }: { flow: Flow; pkg: ShelfPackage }) {
  const { complaints } = flow;
  const differs = flow.zar !== null && flow.zar !== pkg.price_zar;
  return (
    <>
      <Field>
        <FieldLabel>{COPY.paymentLabel}</FieldLabel>
        <Select value={flow.code ?? ""} onValueChange={(c) => { flow.setCode(c as SellReasonCode); flow.setComplaints((x) => ({ ...x, code: undefined })); }}>
          <SelectTrigger><SelectValue placeholder={COPY.paymentPlaceholder} /></SelectTrigger>
          <SelectContent>
            {PAYMENT_CHOICES.map((c) => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldError>{complaints.code}</FieldError>
      </Field>
      <Field>
        <FieldLabel>{COPY.zarLabel}</FieldLabel>
        <Input inputMode="decimal" autoComplete="off" value={flow.zarText} className="tabular-nums" onChange={(e) => flow.setZarText(e.target.value)} />
        <FieldDescription>{differs ? COPY.zarDiffers(formatMoney(pkg.price_zar)) : COPY.zarHelp(formatMoney(pkg.price_zar))}</FieldDescription>
        <FieldError>{complaints.zar}</FieldError>
      </Field>
      <NoteField flow={flow} />
    </>
  );
}

/** How it was paid and the note, as the ledger will word them; a gift has only its note (R7 J7-10). */
function noteLine(flow: Flow): string {
  // Joined, not template literals in a ternary: lizard loses its place in those and swallows the file.
  const quoted = "“" + flow.detail.trim() + "”";
  return flow.free ? quoted : reasonLabel(flow.code ?? "") + " — " + quoted;
}

/** A package that costs the member nothing: no payment, no money received — only the note (R7 J7-10). */
function FreeStep({ flow }: { flow: Flow }) {
  return (
    <>
      <p className="text-sm text-text-secondary" data-sale-free="">{COPY.freeNote}</p>
      <NoteField flow={flow} />
    </>
  );
}

function NoteField({ flow }: { flow: Flow }) {
  return (
    <Field>
      <FieldLabel>{COPY.detailLabel}</FieldLabel>
      <Input autoComplete="off" value={flow.detail} placeholder={COPY.detailPlaceholder} onChange={(e) => flow.setDetail(e.target.value)} />
      <FieldDescription>{COPY.detailHint}</FieldDescription>
      <FieldError>{flow.complaints.detail}</FieldError>
    </Field>
  );
}

function SaleCheck({ flow, pkg, balance }: { flow: Flow; pkg: ShelfPackage; balance: number | null }) {
  const zar = flow.zar ?? pkg.price_zar;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border bg-bg-muted p-4 text-sm">
        <dt className="text-text-secondary">{COPY.balanceNow}</dt>
        <dd className="text-right text-text-primary">{balance === null ? "—" : <Minutes value={balance} />}</dd>
        <dt className="text-text-secondary">{COPY.adds}</dt>
        <dd className="text-right font-semibold text-text-primary">{pkg.name} · <Minutes value={pkg.minutes} signed /></dd>
        <div aria-hidden="true" className="col-span-2 my-1 h-px bg-border" />
        <dt className="font-semibold text-text-primary">{COPY.balanceAfter}</dt>
        <dd className="text-right font-semibold text-text-primary">{balance === null ? "—" : <Minutes value={balance + pkg.minutes} />}</dd>
        {flow.free ? null : (
          <>
            <dt className="text-text-secondary">{COPY.zarRow}</dt>
            <dd className="text-right tabular-nums text-text-primary">{formatMoney(zar)}</dd>
          </>
        )}
      </dl>
      <p className="text-sm text-text-secondary">{noteLine(flow)}</p>
      <p className="text-sm text-text-muted">{COPY.revenueFor(zar)}</p>
      <p className="text-sm text-text-muted">{LIVE_PUSH_NOTE}</p>
    </>
  );
}

/** The receipt STAYS: money deserves more than a toast. */
function SaleReceipt({ name, done }: { name: string; done: Receipt }) {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <AnimatedCheck size={48} className="text-success-strong" />
      <p className="text-lg font-semibold text-success-strong" role="status">{doneSentence(name, done.balanceAfter)}</p>
      <p className="max-w-prose text-sm text-text-secondary">{COPY.receiptFor(name, done.pkg.name, done.pkg.minutes, done.free)}</p>
      {done.recovered ? <p className="max-w-prose text-sm text-text-secondary">{LOST_REPLY.landed}</p> : null}
      <p className="max-w-prose text-sm text-text-secondary">{LIVE_PUSH_NOTE}</p>
    </div>
  );
}

type FooterProps = {
  flow: Flow; guard: SendingGuard; sale: ReturnType<typeof useSalePress>; shelf: ShelfState; name: string;
};

function SaleFooter({ flow, guard, sale, shelf, name }: FooterProps) {
  const leave = () => guard.onOpenChange(false);
  if (flow.done) return <Button onClick={leave}>{COPY.done}</Button>;
  if (flow.step === 1) {
    return (
      <>
        <Button variant="outline" onClick={leave}>{COPY.cancel}</Button>
        <Button onClick={flow.toPayment} disabled={shelf.status !== "ready"}>{COPY.next}</Button>
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
  const pkg = flow.pkg;
  if (!pkg) return null;
  return (
    <>
      <Button variant="outline" disabled={sale.busy} onClick={() => flow.setStep(2)}>{COPY.back}</Button>
      <div className="min-w-0" data-sale-confirm="">
        <ConfirmButton
          idleLabel={COPY.idleFor(pkg.minutes, flow.free)}
          cancelLabel={COPY.cancel}
          confirmLabel={COPY.confirmFor(name, pkg.name, flow.zar ?? pkg.price_zar)}
          ariaLabel={name}
          subject={name}
          tone="info"
          idleClassName={buttonVariants({ variant: "primary" })}
          disabled={sale.busy}
          onConfirm={async () => {
            guard.setSending(true);
            try {
              return await sale.press();
            } finally {
              guard.setSending(false);
            }
          }}
          className="min-h-touch w-full"
        />
      </div>
    </>
  );
}
