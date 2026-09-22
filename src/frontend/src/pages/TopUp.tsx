import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, endpoints, type PayFastFormField, type TopUpOptions } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";
import { describeTopUpRate, formatMoney, spokenMoney } from "../lib/utils";
import { spokenCurrencyName } from "../lib/currency";
import { useBalance, walletTone } from "../lib/balance";
import { useClubUi } from "../lib/clubUi";
import { BALANCE_SENTENCE } from "../lib/walletCopy";

/**
 * Why an amount is not acceptable, or null when it is.
 *
 * <p>
 * The rules come from `tenant_settings` via `GET /credit/topup/options`, not from
 * literals. The screen used to carry `MIN_ZAR = 100`, `MAX_ZAR = 1000`, `BLOCK_ZAR = 100`
 * and two hardcoded conversion rates, so the moment an admin moved any of them the member
 * was quoted 60% more than their wallet would receive, offered amounts the club had
 * stopped accepting, and refused amounts it did accept.
 * </p>
 *
 * <p>
 * The shape is checked before the value. `parseFloat` accepted "200abc" as 200, and
 * `Number` — which replaced it — is right about that one and wrong about the rest of
 * the family: it reads "1e3" as 1000, "0x64" as 100, "0b11" as 3 and a string of spaces
 * as 0. This comment used to claim "1e3" was refused; it never was, the button enabled
 * and the screen quoted a wallet of 1600 for it. The amount is not wrong money — the
 * server registers R1000 and the ledger agrees — but a money field that silently accepts
 * programmer notation will mislead the next person who reads this, and a member who
 * meant 13 and typed 1e3 is quoted eighty times what they meant with nothing to say so.
 * An amount is digits, optionally a decimal point and more digits, and nothing else;
 * the leading minus is allowed through so a typed "-100" still gets the sentence about
 * zero rather than the one about digits.
 * </p>
 *
 * <p>
 * <b>No currency NAME in any of these sentences.</b> They used to say "enter an amount in
 * rand", which was true for exactly one club: the symbol beside this field is
 * `tenant_settings.currency_symbol`, and a club on CHF was being told to type rand into a
 * field labelled CHF. There is no way to get a noun back from a symbol — `spokenCurrencyName`
 * names the handful it knows and answers null for the rest — so the visible sentences say
 * what is wrong with what was typed and let the symbol beside the field name the money. The
 * noun survives only where a screen reader needs one, which is `spokenMoney`.
 * </p>
 */
const PLAIN_AMOUNT = /^-?\d+(\.\d+)?$/;

/** Not a number, said the same way wherever the shape fails. */
const NOT_A_NUMBER = "That isn't a number — enter digits only, like 200.";

function amountProblem(text: string, o: TopUpOptions | null): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Enter an amount to top up.";
  if (!PLAIN_AMOUNT.test(trimmed)) return NOT_A_NUMBER;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return NOT_A_NUMBER;
  if (!o) return null;
  if (value <= 0) return "Enter an amount greater than zero.";
  if (value > o.max_zar) return `The most you can top up at once is ${formatMoney(o.max_zar)}.`;
  if (value < o.min_zar) return `The smallest top-up is ${formatMoney(o.min_zar)}.`;
  // Money in cents, so compare on cents rather than on floats: 150 % 50 is exact, but
  // 0.1 + 0.2 arithmetic on a decimal amount is not.
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
 * from the POST onward and not before it, so an admin changing the member's class — or
 * editing the club's `credits_per_zar_*`, which reaches EVERY member with this screen open
 * — moved the price under the tab. The screen went on promising a wallet of 240, Continue
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
type RestatedQuote = { rate: number; walletGain: number };

function reQuote(
  payload: Record<string, unknown>,
  setOptions: React.Dispatch<React.SetStateAction<TopUpOptions | null>>,
  setRestated: React.Dispatch<React.SetStateAction<RestatedQuote | null>>,
): void {
  const rate = Number(payload.conversion_rate);
  // `quoted_credits` is the WIRE name and stays one — it is what the API sends. What it
  // carries is how much the wallet goes up by, which is what the screen has to say in words.
  const walletGain = Number(payload.quoted_credits);
  const memberClass = payload.member_class === "LeagueOrSenior" || payload.member_class === "Regular"
    ? payload.member_class
    : null;
  // A refusal that carries no readable rate is not a re-quote — moving the screen to NaN
  // would be worse than leaving it on a figure the member can still press Continue against
  // and be refused again. The caller's `START_ERRORS` fallback is not reachable from here,
  // so this returns having changed nothing and the member sees the old, honest offer.
  if (!Number.isFinite(rate)) return;
  setOptions((o) => (o ? { ...o, conversion_rate: rate, member_class: memberClass ?? o.member_class } : o));
  setRestated({ rate, walletGain: Number.isFinite(walletGain) ? walletGain : Number.NaN });
}

export default function TopUpPage() {
  const { currencySymbol } = useClubUi();
  // The noun, for the things a screen reader SAYS. Null for a symbol this product cannot
  // name, which is a fallback rather than a guess — see `spokenCurrencyName`. Read from the
  // MODULE store rather than from the context, so it cannot disagree with `spokenMoney` and
  // `formatMoney`, which read the same store: the provider writes both from one field, and a
  // screen that took the symbol from one source and the noun from another would be free to
  // announce "CHF320.00" as rand.
  const spokenName = spokenCurrencyName();
  const nav = useNavigate();
  /*
    Only to say WHY the member is here, never to gate anything: a balance that has not
    loaded is `null`, which `walletTone` reads as nothing to warn about, and the form
    behaves identically either way.
  */
  const { balance } = useBalance();
  const emptyWallet = walletTone(balance) === "zero";
  const [options, setOptions] = useState<TopUpOptions | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * The club's rate moved between this page loading and the member pressing Continue, so
   * the payment is held HERE rather than sent on to PayFast. It carries the figures the
   * server registered, and the member's next press proceeds at those.
   */
  const [restated, setRestated] = useState<RestatedQuote | null>(null);

  const loadOptions = useCallback(() => {
    endpoints.topupOptions()
      .then((o) => {
        setOptions(o);
        setAmount((current) => (current === "" ? String(o.presets_zar[0] ?? o.min_zar) : current));
      })
      .catch(() => setError("Couldn't load the club's top-up settings. Try again in a moment."));
  }, []);

  useEffect(() => { loadOptions(); }, [loadOptions]);

  // A tab left open across a class change or a settings edit quotes a price the club will
  // not honour, and a member who switches away and back is the commonest way that happens.
  // Re-reading on focus narrows the window; the check at Continue below is what closes it.
  useEffect(() => {
    const onFocus = () => loadOptions();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadOptions]);

  const problem = amountProblem(amount, options);
  const value = Number(amount.trim());
  const canSubmit = options !== null && problem === null;
  // What the WALLET goes up by, which is not what the card is charged. One symbol now writes
  // both, so every place this figure appears has to name which of the two it is.
  const walletGain = canSubmit ? value * options.conversion_rate : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The message is shown rather than swallowed. Every one of these branches was
    // unreachable before, because the same predicate that produced them also disabled the
    // button — so an invalid amount greyed the button out and said nothing at all, and the
    // member had to infer the rule from a hint line.
    if (problem) { setError(problem); return; }
    if (!options) { setError("Couldn't load the club's top-up settings. Try again in a moment."); return; }
    setError(null);
    setLoading(true);
    try {
      // The quoted rate travels with the amount, so the server can refuse an offer the club
      // has moved away from rather than registering the member at the new one. Two lanes
      // fixed this defect independently: one compared the two rates HERE, after the POST had
      // already written a pending row at the new one, and one sent the quote so the server
      // could refuse BEFORE writing anything. Only the second cannot be raced, and only the
      // second binds a client that does not implement the check — so it is the one that ships.
      const res = await endpoints.topupStart(value, options.conversion_rate);
      postToGateway(res.redirect_url, res.form_fields);
    } catch (err) {
      const payload = err instanceof ApiError && isRecord(err.payload) ? err.payload : null;
      const code = payload ? String(payload.error ?? "") : "";
      if (code === "topup_rate_changed" && payload) {
        // Not an error: nothing went wrong and nothing was charged, the price simply moved.
        // It reads as a warning with `role="alert"` below rather than as a red failure line,
        // because the member's next press is a normal one.
        reQuote(payload, setOptions, setRestated);
      } else {
        setError(START_ERRORS[code] ?? (err instanceof ApiError
          ? "We couldn't start this payment. Try again in a moment."
          : "No connection — check your signal and try again."));
      }
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4">
      <Card>
        <h1 className="text-xl font-semibold mb-1">Top up</h1>
        {/*
          The lede used to read "Pay in ZAR via PayFast — your wallet is credited in credits
          at your member-class rate", which named a currency this product no longer assumes
          and a unit it no longer has. Both legs of the money are now written in the club's
          one symbol, so the lede says which way the money moves and the preview below says
          how much of it arrives.
        */}
        <p className="text-sm text-text-secondary mb-3">Pay by card or EFT through PayFast. What you pay is added to your wallet at your member-class rate, and your wallet is what pays for court time.</p>
        {/*
          Why they are here, when the answer is "you cannot book anything". A member who has
          followed an empty wallet to this screen has already been told once; saying it again
          where the decision is made is what turns a form into an errand with a reason. It is
          `role="status"`, not `alert`: it is a standing condition they arrived into, not an
          event, and an alert would interrupt whatever the screen reader was saying about the
          heading above it.
        */}
        {emptyWallet && (
          <p role="status" className="mb-5 rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2 text-sm text-danger-strong">
            {BALANCE_SENTENCE.zero}
          </p>
        )}
        <form onSubmit={submit} className="space-y-4">
          <div>
            {/* The club's own symbol, not a hardcoded currency code. Visible only: a symbol
                is not speakable, so the field carries a spoken name of its own below, and
                `htmlFor` is what still makes this label a click target for the input. */}
            <Label htmlFor="topup-amount">Amount ({currencySymbol})</Label>
            <div className="flex gap-2 mb-2 flex-wrap">
              {(options?.presets_zar ?? []).map((p) => (
                <Button key={p} type="button" variant={String(p) === amount ? "default" : "outline"} onClick={() => { setAmount(String(p)); setError(null); setRestated(null); }}>
                  {/* Through the one formatter, symbol and all. This was `R{p}`: the most
                      visible money control on the member's own top-up screen, composing a
                      currency sign by hand two lines above a limits line that did not. */}
                  {formatMoney(p)}
                </Button>
              ))}
            </div>
            <Input
              id="topup-amount"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null); setRestated(null); }}
              inputMode="decimal"
              /*
                An `aria-label` REPLACES the visible label as the accessible name, which is
                exactly what is wanted here: "Amount (R)" is announced as the letter R in
                brackets. `spokenCurrencyName` answers null for a symbol it cannot name, and
                then the field is simply "Amount" — true in any currency, and never a guess
                at the wrong one.
              */
              aria-label={spokenName ? `Amount in ${spokenName}` : "Amount"}
              placeholder={options ? `Custom amount (multiple of ${formatMoney(options.block_zar)})` : "Custom amount"}
            />
            <p className="text-xs text-text-muted mt-1">
              {options
                ? `Min ${formatMoney(options.min_zar)} · Max ${formatMoney(options.max_zar)} · Multiples of ${formatMoney(options.block_zar)} only`
                : "Loading the club's limits…"}
            </p>
          </div>

          <ConversionPreview options={options} paid={canSubmit ? value : null} walletGain={walletGain} />

          {/*
            No apostrophe in this paragraph, deliberately. lizard's .tsx lexer treats a bare
            ' in JSX TEXT as a string-literal opener and swallows the rest of the file into
            one anonymous function, which `make complexity` then reports at line 183 with 8
            PARAM and a length nobody wrote. The file's other apostrophes happen to come in
            pairs, so it resyncs; adding an odd one broke it. Same family as the bare `<`
            trap already recorded for this parser.
          */}
          {restated && (
            /*
              Both figures wear the same symbol, so the sentence carries the direction the
              units used to. "R100.00 now buys R160.00" reads as nonsense; "R100.00 now adds
              R160.00 to your wallet instead" says which side each figure is on and that the
              second one moved. The rate itself is restated by the preview above, which
              `reQuote` has already moved onto the new figure.
            */
            <p role="alert" className="text-sm text-warning-strong">
              The club changed its rate while this page was open, so nothing has been sent to
              PayFast yet. {formatMoney(value)} now adds{" "}
              {formatMoney(Number.isFinite(restated.walletGain) ? restated.walletGain : value * restated.rate)}
              {" "}to your wallet instead. Press Continue again to pay at that rate.
            </p>
          )}

          {/* The reason an amount isn't accepted, shown as soon as it isn't — not only on submit. */}
          {(error ?? (amount.trim() !== "" && problem)) && (
            <p className="text-sm text-danger-strong">{error ?? problem}</p>
          )}
          {/* Item 12's pair on the page that spends real money. No `onAction`: this is a
              form submit that ends in a redirect to PayFast, so "it worked" is the payment
              page appearing, and a green tick on a button the member is about to leave behind
              would be a claim about a payment that has not happened yet. */}
          <Button intent="affirm" type="submit" disabled={loading || !canSubmit} className="w-full">{loading ? "Redirecting…" : "Continue to PayFast"}</Button>
          <Button intent="decline" type="button" variant="ghost" onClick={() => nav("/wallet")} className="w-full">Cancel</Button>
        </form>
      </Card>
    </div>
  );
}

/**
 * <b>The conversion boundary — the one block on this screen that must say both legs in
 * words.</b>
 *
 * <p>
 * `lib/currency.ts` carries the ruling and the rule it imposes: every amount in the product
 * is now written in one configurable symbol, so a wallet and a card payment are no longer
 * told apart by their units. A club on 1.6 is giving a 60% bonus, and this block used to
 * render that as "You pay R100.00 / You receive R160.00" with nothing between the two
 * figures — which reads as a screen with a bug in it rather than as an offer.
 * </p>
 *
 * <p>
 * So each row names the SIDE it is on, the difference is attributed to the club in a
 * sentence, and the standing note answers the residual risk the owner accepted: a member
 * reading a wallet as withdrawable cash. The bonus sentence appears only when there IS one —
 * a club on 1:1 adds nothing, and a club below 1:1 must never be made to claim it does.
 * </p>
 *
 * <p>
 * <b>Not one apostrophe in the JSX text below, deliberately.</b> lizard's .tsx lexer reads a
 * bare <code>'</code> in JSX text as a string opener and swallows the rest of the file into
 * one anonymous function, so `make complexity` goes red on a line nobody touched. This file
 * used to rely on its apostrophes happening to come in pairs.
 * </p>
 *
 * <p>
 * Extracted rather than inlined for a second reason: with the apostrophes gone, lizard sees
 * the true extent of `TopUpPage` for the first time — the trap had been truncating it at the
 * first bare one — and the whole page in one function is over the 200-line limit.
 * </p>
 */
function ConversionPreview(
  { options, paid, walletGain }: { options: TopUpOptions | null; paid: number | null; walletGain: number | null },
) {
  const bonus = paid !== null && walletGain !== null ? walletGain - paid : null;
  return (
    <div data-testid="conversion-preview" className="bg-bg-muted rounded-lg p-3 text-sm">
      <div className="flex items-baseline justify-between">
        <span className="text-text-secondary">You pay PayFast</span>
        <span className="font-semibold">{paid === null ? "—" : formatMoney(paid)}</span>
      </div>
      <div className="flex items-baseline justify-between mt-1">
        <span className="text-text-secondary">Added to your wallet</span>
        <span className="font-semibold text-accent-strong">{walletGain === null ? "—" : formatMoney(walletGain)}</span>
      </div>
      {/*
        Spoken, because the two figures beside their labels are symbols and a symbol is not
        speakable: a reader handed "R320.00" announces the R as a letter, which is the same
        defect "cr" had in a different hat. `spokenMoney` supplies the noun where the product
        knows one and a bare number where it does not.
      */}
      {paid !== null && walletGain !== null && (
        <p role="status" className="sr-only">
          Paying {spokenMoney(paid)} adds {spokenMoney(walletGain)} to your wallet.
        </p>
      )}
      {bonus !== null && bonus > 0 && (
        <p className="mt-2 text-xs text-text-secondary">
          The club adds {formatMoney(bonus)} on top of what you pay.
        </p>
      )}
      <p className="mt-1 text-xs text-text-muted">Your wallet pays for court time. It is not cash and cannot be paid back out.</p>
      {options && (
        /*
          What this sentence may claim is exactly what the code keeps. It used to read "This
          rate is locked in when you continue, so it can't change while you're paying" — and
          the club rate could move under a tab left open, so the member pressed Continue on a
          wallet of 480 and the server registered 320. Three finders drove that in round 3.
          The rate IS frozen from the moment the pending row is written
          (`PendingTopup.ConversionRate` is what the ITN settles at); what was never true is
          that the figure ON SCREEN is the one that gets frozen. So the promise names the
          moment, and `submit` stops rather than pays when the two disagree.

          The class label survives a restatement and stays true through one: the 409 carries
          `member_class` beside the new rate, so `reQuote` moves both together rather than
          leaving the new number beside the old reason for it.
        */
        <p className="text-[11px] text-text-muted mt-2">
          {describeTopUpRate(options.conversion_rate)} ({options.member_class === "LeagueOrSenior" ? "league / senior rate" : "regular rate"}).
          Your rate is fixed the moment the club registers this payment, and it cannot change while you are at PayFast.
          If the club has moved its rate since this page loaded, we will show you the new figure before sending you there.
        </p>
      )}
    </div>
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
