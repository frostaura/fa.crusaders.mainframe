import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError, endpoints, type PayFastFormField, type RateGroup, type TopUpOptions } from "../lib/api";
import { yourRateLine } from "../lib/groupsCopy";
import { cn, formatCredits, describeTopUpRate, formatMoney } from "../lib/utils";
import { clubCurrencySymbol } from "../lib/currency";
import { useBalance, walletTone } from "../lib/balance";
import { BALANCE_SENTENCE } from "../lib/walletCopy";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { StateBlock } from "../components/ui/state-block";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { ArrowDown, Coins } from "../components/ui/icons";
import { Alert } from "../components/Alert";
import { parseAmount } from "../lib/amount";
import { rememberTopUpReturn, safeReturnTo } from "../lib/topUpReturn";

/**
 * Why an amount is not acceptable, or null when it is.
 *
 * <p>
 * The rules come from `tenant_settings` via `GET /credit/topup/options`, not from
 * literals. The screen used to carry `MIN_ZAR = 100`, `MAX_ZAR = 1000`, `BLOCK_ZAR = 100`
 * and two hardcoded conversion rates, so the moment an admin moved any of them the member
 * was quoted 60% more credits than they would receive, offered amounts the club had
 * stopped accepting, and refused amounts it did accept.
 * </p>
 *
 * <p>
 * The shape is checked before the value. `parseFloat` accepted "200abc" as 200, and
 * `Number` — which replaced it — is right about that one and wrong about the rest of
 * the family: it reads "1e3" as 1000, "0x64" as 100, "0b11" as 3 and a string of spaces
 * as 0. This comment used to claim "1e3" was refused; it never was, the button enabled
 * and the screen quoted 1600 credits for it. The amount is not wrong money — the server
 * registers R1000 and the ledger agrees — but a rand field that silently accepts
 * programmer notation will mislead the next person who reads this, and a member who
 * meant 13 and typed 1e3 is quoted eighty times what they meant with nothing to say so.
 * A rand amount is what `lib/amount.ts` accepts (digits, one decimal point or comma) and
 * nothing else; a leading minus still gets the sentence about zero rather than the one
 * about digits.
 * </p>
 */
function randValue(text: string): number | null {
  // F3.18: the one shared parser — a decimal comma is a member's own notation, an exponent never is.
  const parsed = parseAmount(text, { allowZero: true });
  if (parsed.ok) return parsed.value;
  return parsed.problem.kind === "negative" ? -1 : null;
}

function amountProblem(text: string, o: TopUpOptions | null): string | null {
  if (text.trim() === "") return "Enter an amount in rand.";
  const value = randValue(text);
  if (value === null) return "That isn't a number — enter an amount in rand.";
  if (!o) return null;
  if (value <= 0) return "Enter an amount greater than zero.";
  if (value > o.max_zar) return `The most you can top up at once is ${formatMoney(o.max_zar)}.`;
  if (value < o.min_zar) return `The smallest top-up is ${formatMoney(o.min_zar)}.`;
  // Money in cents, so compare on cents rather than on floats: 150 % 50 is exact, but
  // 0.1 + 0.2 arithmetic on rand is not.
  if (Math.round(value * 100) % Math.round(o.block_zar * 100) !== 0)
    return `Top-ups go in multiples of ${formatMoney(o.block_zar)}.`;
  return null;
}

/** Errors the API can answer this screen with, in the member's own words. */
const START_ERRORS: Record<string, string> = {
  amount_must_be_positive: "Enter an amount greater than zero.",
  amount_must_be_multiple_of_block: "That amount isn't a whole block — pick one of the amounts above.",
  amount_exceeds_member_cap: "That's more than the club's top-up limit. Try a smaller amount.",
  payments_not_configured: "Payments aren't set up for this club yet — please ask an admin.",
  provider_register_failed: "PayFast wouldn't start this payment. Try again in a minute.",
};

/**
 * The rate the member is looking at, re-quoted when the club has moved it.
 *
 * <p>
 * `/credit/topup/options` is fetched once on mount and never revalidated, and this screen
 * promises beside the figure that the rate is locked in when you continue. It was locked
 * from the POST onward and not before it, so an admin changing the member's groups — or
 * editing the club's `credits_per_zar_*`, which reaches EVERY member with this screen open
 * — moved the price under the tab. The screen went on saying 240.00 credits, Continue
 * registered 160, and the next thing the member saw was a card form. Two testers
 * reproduced it independently on the same day.
 * </p>
 *
 * <p>
 * The server now refuses a stale quote with `topup_rate_changed` instead of repricing it,
 * so the member is never charged at a rate they were not shown. This puts the new figure
 * on the screen and stops, rather than continuing to the gateway — the member commits to
 * the new price by pressing the button again, deliberately.
 * </p>
 */
/**
 * The figures a refusal restated, held so the screen can show them and the next press pay at
 * them. A named type rather than an inline object literal in the generic below: lizard's .tsx
 * lexer reads the `<` of `React.Dispatch<...>` as a JSX tag when braces follow inside it, never
 * finds the close, and swallows the rest of the file into `submit` — which then measured 72
 * NLOC / 27 CCN / 133 length and failed `make complexity` on a function nobody had grown. Same
 * family as the bare-apostrophe and bare-`<` traps already noted in this file.
 */
type RestatedQuote = { rate: number; credits: number };

function reQuote(
  payload: Record<string, unknown>,
  setOptions: React.Dispatch<React.SetStateAction<TopUpOptions | null>>,
  setRestated: React.Dispatch<React.SetStateAction<RestatedQuote | null>>,
): void {
  const rate = Number(payload.conversion_rate);
  const credits = Number(payload.quoted_credits);
  // D2: the group the NEW rate comes from travels with the refusal, so the line under the figure
  // never names the new number beside the old reason for it. Absent (an older API) keeps the old.
  const rateGroup = "rate_group" in payload ? rateGroupFrom(payload.rate_group) : undefined;
  // A refusal that carries no readable rate is not a re-quote — moving the screen to NaN
  // would be worse than leaving it on a figure the member can still press Continue against
  // and be refused again. The caller's `START_ERRORS` fallback is not reachable from here,
  // so this returns having changed nothing and the member sees the old, honest offer.
  if (!Number.isFinite(rate)) return;
  setOptions((o) => (o ? { ...o, conversion_rate: rate, ...(rateGroup === undefined ? {} : { rate_group: rateGroup }) } : o));
  setRestated({ rate, credits: Number.isFinite(credits) ? credits : Number.NaN });
}

/** `rate_group` off the wire: `{id, name}` or null (the club's standard rate); anything else is unknown. */
function rateGroupFrom(raw: unknown): RateGroup | null | undefined {
  if (raw === null) return null;
  if (isRecord(raw) && typeof raw.name === "string" && typeof raw.id === "string") {
    return { id: raw.id, name: raw.name, system_key: typeof raw.system_key === "string" ? raw.system_key : null };
  }
  return undefined;
}

/** The club's top-up rules, read on mount and again whenever the tab regains focus. */
function useTopUpOptions(setAmount: (update: (current: string) => string) => void) {
  const [options, setOptions] = useState<TopUpOptions | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const loadOptions = useCallback(() => {
    endpoints.topupOptions()
      .then((o) => {
        setOptions(o);
        setLoadError(null);
        setAmount((current) => (current === "" ? String(o.presets_zar[0] ?? o.min_zar) : current));
      })
      .catch((err: unknown) => setLoadError(err ?? new Error("options read failed")));
  }, [setAmount]);

  useEffect(() => { loadOptions(); }, [loadOptions]);

  // A tab left open across a group change or a settings edit quotes a price the club will
  // not honour, and a member who switches away and back is the commonest way that happens.
  // Re-reading on focus narrows the window; the check at Continue below is what closes it.
  useEffect(() => {
    const onFocus = () => loadOptions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadOptions]);

  return { options, setOptions, loadError, loadOptions };
}

const UNREACHABLE = "No connection — check your signal and try again.";
const NOT_STARTED = "We couldn't start this payment. Try again in a moment.";
const HEADER_COPY = "Pay in rand with PayFast. Your wallet is credited in credits, at your member rate.";

export default function TopUpPage() {
  /*
    Only to say WHY the member is here, never to gate anything: a balance that has not
    loaded is `null`, which `walletTone` reads as nothing to warn about, and the form
    behaves identically either way.
  */
  const { balance } = useBalance();
  const emptyWallet = walletTone(balance) === "zero";
  const [amount, setAmount] = useState<string>("");
  const { options, setOptions, loadError, loadOptions } = useTopUpOptions(setAmount);

  return (
    <PageShell width="narrow">
      <PageHeader back={{ to: "/wallet", label: "Wallet" }} title="Top up" description={HEADER_COPY} />
      {/*
        Why they are here, when the answer is "you cannot book anything". A member who has
        followed an empty wallet to this screen has already been told once; saying it again
        where the decision is made is what turns a form into an errand with a reason. Polite,
        not an alert: it is a standing condition they arrived into, not an event.
      */}
      {emptyWallet && <Alert tone="danger" live="polite">{BALANCE_SENTENCE.zero}</Alert>}
      <StateBlock
        loading={options === null && !loadError}
        error={options === null ? loadError : null}
        action="load the club's top-up settings"
        onRetry={loadOptions}
        skeleton={<TopUpSkeleton />}
      >
        {options ? <TopUpForm options={options} setOptions={setOptions} amount={amount} setAmount={setAmount} /> : null}
      </StateBlock>
    </PageShell>
  );
}

/** The form's shape while the club's rules are read: presets, the field, the summary, the CTA. */
function TopUpSkeleton() {
  return (
    <Card className="px-4 sm:px-6">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <div className="flex flex-wrap gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-touch w-20" />)}</div>
      </div>
      <Skeleton className="h-touch" />
      <Skeleton className="h-24" />
      <Skeleton className="h-touch" />
    </Card>
  );
}

type FormProps = {
  options: TopUpOptions;
  setOptions: React.Dispatch<React.SetStateAction<TopUpOptions | null>>;
  amount: string;
  setAmount: (value: string) => void;
};

function TopUpForm(props: FormProps) {
  // `?returnTo=` — where the member came from (an invite, usually); kept for the status page.
  const [search] = useSearchParams();
  const returnTo = safeReturnTo(search.get("returnTo"));
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { options, setOptions, amount, setAmount } = props;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Submit was pressed on an amount the club will not take: say why even if the field is empty. */
  const [tried, setTried] = useState(false);
  /**
   * The club's rate moved between this page loading and the member pressing Continue, so
   * the payment is held HERE rather than sent on to PayFast. It carries the figures the
   * server registered, and the member's next press proceeds at those.
   */
  const [restated, setRestated] = useState<RestatedQuote | null>(null);

  const problem = amountProblem(amount, options);
  const value = randValue(amount) ?? Number.NaN;
  const canSubmit = problem === null;
  const creditsPreview = canSubmit ? value * options.conversion_rate : null;

  const choose = (next: string) => { setAmount(next); setError(null); setRestated(null); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // The message is shown rather than swallowed: an invalid amount used to grey the button
    // out and say nothing at all.
    if (problem) { setTried(true); return; }
    setError(null);
    setLoading(true);
    try {
      // The quoted rate travels with the amount, so the server can refuse an offer the club
      // has moved away from rather than registering the member at the new one — before it
      // writes anything, which is the only version that cannot be raced.
      const res = await endpoints.topupStart(value, options.conversion_rate);
      // The way back (an invite, usually) must survive PayFast, whose return URLs are the server's.
      rememberTopUpReturn(res.topup_id, returnTo);
      postToGateway(res.redirect_url, res.form_fields);
    } catch (err) {
      const payload = err instanceof ApiError && isRecord(err.payload) ? err.payload : null;
      const code = payload ? String(payload.error ?? "") : "";
      if (code === "topup_rate_changed" && payload) {
        // Not an error: nothing went wrong and nothing was charged, the price simply moved.
        reQuote(payload, setOptions, setRestated);
      } else {
        setError(START_ERRORS[code] ?? (err instanceof ApiError ? NOT_STARTED : UNREACHABLE));
      }
      setLoading(false);
    }
  };

  const shownProblem = amount.trim() !== "" || tried ? problem : null;
  return (
    <Card className="px-4 sm:px-6">
      <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
        <AmountFields options={options} amount={amount} onChoose={choose} problem={shownProblem} />
        <Summary options={options} pay={canSubmit ? value : null} receive={creditsPreview} />
        {restated && <RestatedNotice value={value} restated={restated} />}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-col gap-2">
          {/* No success mark: this ends in a redirect to PayFast, so "it worked" is the payment
              page appearing, and a tick on a button the member is leaving would be a claim
              about a payment that has not happened yet. */}
          <Button type="submit" block size="lg" pending={loading} disabled={!canSubmit}>Continue to PayFast</Button>
          {/* F4-12 — back where the member came from (an invite, usually), not always the wallet. */}
          <Button asChild variant="ghost" block>
            <Link to={returnTo ?? "/wallet"}>Cancel</Link>
          </Button>
        </div>
      </form>
    </Card>
  );
}

type AmountProps = { options: TopUpOptions; amount: string; onChoose: (value: string) => void; problem: string | null };

/**
 * The preset amounts are a single choice — a radio group (ToggleGroup) — and the field below
 * is the same value typed by hand. Choosing a preset fills the field; typing a preset's figure
 * selects it.
 */
function AmountFields({ options, amount, onChoose, problem }: AmountProps) {
  const selected = options.presets_zar.some((p) => String(p) === amount.trim()) ? amount.trim() : "";
  const limits = `Min ${formatMoney(options.min_zar)} · Max ${formatMoney(options.max_zar)} · Multiples of ${formatMoney(options.block_zar)} only`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span id="topup-presets" className="text-sm font-medium text-text-primary">Amount</span>
        <ToggleGroup
          type="single"
          variant="outline"
          aria-labelledby="topup-presets"
          value={selected}
          onValueChange={(next) => { if (next) onChoose(next); }}
          size="lg"
          className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {options.presets_zar.map((p) => (
            <ToggleGroupItem key={p} value={String(p)} className="text-base tabular-nums">{`R${p}`}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <Field>
        <FieldLabel>Or enter an amount (ZAR)</FieldLabel>
        {/* The currency sits INSIDE the field, so the number typed is plainly money and not
            credits — the one confusion this screen exists to prevent. aria-hidden: the label
            already says "(ZAR)", and a screen reader reading "R" before every value is noise. */}
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base font-semibold text-text-secondary sm:text-sm"
          >
            {clubCurrencySymbol()}
          </span>
          <Input
            value={amount}
            onChange={(e) => onChoose(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder={`Custom amount (multiple of ${formatMoney(options.block_zar)})`}
            className="pl-8 font-semibold tabular-nums"
          />
        </div>
        <FieldDescription>{limits}</FieldDescription>
        <FieldError>{problem}</FieldError>
      </Field>
    </div>
  );
}

/**
 * What the member pays and what they get, and exactly what the rate promise covers.
 *
 * <p>
 * It once read "This rate is locked in when you continue, so it can't change while you're
 * paying" — and the club's rate could move under a tab left open, so a member pressed Continue
 * on 480 credits and the server registered 320. The rate IS frozen from the moment the pending
 * row is written; what was never true is that the figure ON SCREEN is the one that gets frozen.
 * So the promise names the moment, and `submit` stops rather than pays when the two disagree.
 * "Your rate: League — 2.4 cr per R1" names the GROUP the rate comes from (D2 — groups replaced the
 * member class), and moves with a restated rate (`reQuote`), so the line never names the new
 * number beside the old reason for it.
 * </p>
 */
function Summary({ options, pay, receive }: { options: TopUpOptions; pay: number | null; receive: number | null }) {
  return (
    // The receipt the member reads before they leave for PayFast: rand in, credits out, and the
    // arrow between them is the conversion. Live — it moves as they type or pick a chip.
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-muted p-4">
      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-text-secondary">You pay</dt>
          <dd className="text-base font-semibold tabular-nums text-text-primary">{pay === null ? "—" : formatMoney(pay)}</dd>
        </div>
        <ArrowDown size={16} weight="bold" aria-hidden="true" className="ml-auto mr-6 text-text-muted" />
        <div className="flex items-baseline justify-between gap-4">
          <dt className="inline-flex items-center gap-1.5 text-text-secondary">
            <Coins size={16} aria-hidden="true" className="text-accent-strong" />
            You receive
          </dt>
          <dd className={cn("text-xl font-bold tabular-nums", receive === null ? "text-text-muted" : "text-accent-strong")}>
            {receive === null ? "—" : formatCredits(receive, { long: true })}
          </dd>
        </div>
      </dl>
      <p className="border-t border-border pt-3 text-xs text-text-secondary">
        <span className="block font-medium text-text-primary" data-testid="your-rate">{yourRateLine(options.conversion_rate, options.rate_group)}</span>
        {`${describeTopUpRate(options.conversion_rate)}. `}
        {RATE_PROMISE}
      </p>
    </div>
  );
}

const RATE_PROMISE = "Your rate is fixed the moment the club registers this payment, and it can't change while you're at PayFast. "
  + "If the club's rate has moved since this page loaded, we'll show you the new figure before sending you there.";

function RestatedNotice({ value, restated }: { value: number; restated: RestatedQuote }) {
  const credits = Number.isFinite(restated.credits) ? restated.credits : value * restated.rate;
  return (
    <Alert tone="warning">
      {"The club changed its rate while this page was open, so nothing has been sent to PayFast yet. "}
      {`${formatMoney(value)} now buys ${formatCredits(credits, { long: true })} at ${describeTopUpRate(restated.rate)}. `}
      {"Press Continue again to pay at that rate."}
    </Alert>
  );
}

/**
 * Hands the browser to PayFast by **submitting the signed form the API built**.
 *
 * <p>
 * This was `window.location.href = res.redirect_url` — a GET to PayFast's process
 * endpoint with no query string at all: no merchant id, no amount, no signature. PayFast
 * cannot start a payment from that, so no member could ever pay. PayFast has no
 * server-side checkout registration; the signed form IS the checkout, and the provider
 * had been building and signing one all along with nothing on the wire to carry it.
 * </p>
 *
 * <p>
 * A real form submission rather than `fetch`: the member must LAND on PayFast's page to
 * type a card number, and cross-origin form posts navigate where fetch cannot.
 * </p>
 */
function postToGateway(actionUrl: string, fields: PayFastFormField[]) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = actionUrl;
  form.style.display = "none";
  for (const f of fields) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = f.name;
    input.value = f.value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
