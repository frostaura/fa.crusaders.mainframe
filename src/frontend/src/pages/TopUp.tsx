import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, endpoints, type PayFastFormField, type TopUpOptions } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";
import { formatCredits, formatRate, formatZar } from "../lib/utils";

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
 * A rand amount is digits, optionally a decimal point and more digits, and nothing else;
 * the leading minus is allowed through so a typed "-100" still gets the sentence about
 * zero rather than the one about digits.
 * </p>
 */
const PLAIN_RAND = /^-?\d+(\.\d+)?$/;

function amountProblem(text: string, o: TopUpOptions | null): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return "Enter an amount in rand.";
  if (!PLAIN_RAND.test(trimmed)) return "That isn't a number — enter an amount in rand.";
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "That isn't a number — enter an amount in rand.";
  if (!o) return null;
  if (value <= 0) return "Enter an amount greater than zero.";
  if (value > o.max_zar) return `The most you can top up at once is ${formatZar(o.max_zar)}.`;
  if (value < o.min_zar) return `The smallest top-up is ${formatZar(o.min_zar)}.`;
  // Money in cents, so compare on cents rather than on floats: 150 % 50 is exact, but
  // 0.1 + 0.2 arithmetic on rand is not.
  if (Math.round(value * 100) % Math.round(o.block_zar * 100) !== 0)
    return `Top-ups go in multiples of ${formatZar(o.block_zar)}.`;
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
function reQuote(
  payload: Record<string, unknown>,
  amountZar: number,
  setOptions: React.Dispatch<React.SetStateAction<TopUpOptions | null>>,
): string {
  const rate = Number(payload.conversion_rate);
  const credits = Number(payload.quoted_credits);
  const memberClass = payload.member_class === "LeagueOrSenior" || payload.member_class === "Regular"
    ? payload.member_class
    : null;
  if (Number.isFinite(rate)) {
    setOptions((o) => (o ? { ...o, conversion_rate: rate, member_class: memberClass ?? o.member_class } : o));
  }
  const nowBuys = Number.isFinite(credits) ? credits : amountZar * rate;
  return `The club changed the credit rate while this page was open — ${formatZar(amountZar)} now buys `
    + `${formatCredits(nowBuys, { long: true })}. Nothing has been charged. Check the new figure and continue when you're happy with it.`;
}

export default function TopUpPage() {
  const nav = useNavigate();
  const [options, setOptions] = useState<TopUpOptions | null>(null);
  const [amount, setAmount] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    endpoints.topupOptions()
      .then((o) => {
        setOptions(o);
        setAmount((current) => (current === "" ? String(o.presets_zar[0] ?? o.min_zar) : current));
      })
      .catch(() => setError("Couldn't load the club's top-up settings. Try again in a moment."));
  }, []);

  const problem = amountProblem(amount, options);
  const value = Number(amount.trim());
  const canSubmit = options !== null && problem === null;
  const creditsPreview = canSubmit ? value * options.conversion_rate : null;

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
      // has moved away from rather than registering the member at the new one.
      const res = await endpoints.topupStart(value, options.conversion_rate);
      postToGateway(res.redirect_url, res.form_fields);
    } catch (err) {
      const payload = err instanceof ApiError && isRecord(err.payload) ? err.payload : null;
      const code = payload ? String(payload.error ?? "") : "";
      setError(code === "topup_rate_changed" && payload
        ? reQuote(payload, value, setOptions)
        : START_ERRORS[code] ?? (err instanceof ApiError
          ? "We couldn't start this payment. Try again in a moment."
          : "No connection — check your signal and try again."));
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-4">
      <Card>
        <h1 className="text-xl font-semibold mb-1">Top up</h1>
        <p className="text-sm text-text-secondary mb-5">Pay in ZAR via PayFast — your wallet is credited in <strong>credits</strong> at your member-class rate.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label>Amount (ZAR)</Label>
            <div className="flex gap-2 mb-2 flex-wrap">
              {(options?.presets_zar ?? []).map((p) => (
                <Button key={p} type="button" variant={String(p) === amount ? "default" : "outline"} onClick={() => { setAmount(String(p)); setError(null); }}>
                  R{p}
                </Button>
              ))}
            </div>
            <Input
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null); }}
              inputMode="decimal"
              placeholder={options ? `Custom amount (multiple of ${formatZar(options.block_zar)})` : "Custom amount"}
            />
            <p className="text-xs text-text-muted mt-1">
              {options
                ? `Min ${formatZar(options.min_zar)} · Max ${formatZar(options.max_zar)} · Multiples of ${formatZar(options.block_zar)} only`
                : "Loading the club's limits…"}
            </p>
          </div>

          {/* Conversion preview */}
          <div className="bg-bg-muted rounded-lg p-3 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-text-secondary">You pay</span>
              <span className="font-semibold">{canSubmit ? formatZar(value) : "—"}</span>
            </div>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-text-secondary">You receive</span>
              <span className="font-semibold text-accent-strong">{creditsPreview === null ? "—" : formatCredits(creditsPreview, { long: true })}</span>
            </div>
            {options && (
              <p className="text-[11px] text-text-muted mt-2">
                At {formatRate(options.conversion_rate)} credits / R1 ({options.member_class === "LeagueOrSenior" ? "league / senior rate" : "regular rate"}).
                This rate is locked in when you continue, so it can't change while you're paying — and if the club
                changes it before then, we'll show you the new figure rather than charge you at it.
              </p>
            )}
          </div>

          {/* The reason an amount isn't accepted, shown as soon as it isn't — not only on submit. */}
          {(error ?? (amount.trim() !== "" && problem)) && (
            <p className="text-sm text-danger-strong">{error ?? problem}</p>
          )}
          <Button type="submit" disabled={loading || !canSubmit} className="w-full">{loading ? "Redirecting…" : "Continue to PayFast"}</Button>
          <Button type="button" variant="ghost" onClick={() => nav("/wallet")} className="w-full">Cancel</Button>
        </form>
      </Card>
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
