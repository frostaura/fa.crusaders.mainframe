/**
 * The club's currency symbol — the sign its unit of account is written in.
 *
 * <p>
 * <b>The owner's ruling, given twice, and this file is where it is written down.</b> First:
 * "instead of a `cr` suffix, have a configurable currency symbol instead which would precede
 * amounts. Like `R ` for ZAR (default)." Then, when the first pass scoped the symbol to real
 * money only: "remember the wording changes from credits and cr to the currency symbol."
 * </p>
 *
 * <p>
 * So every amount in the product is written one way — <code>R50.00</code> — and neither
 * "cr" nor the word "credits" survives as a unit attached to a number.
 * </p>
 *
 * <h3>What that collapses, and the risk it carries</h3>
 *
 * <p>
 * The product renders two quantities that are <b>not the same size</b>:
 * </p>
 *
 * <ul>
 *   <li><b>What a member pays the gateway.</b> <code>topup_block_zar</code>,
 *       <code>topup_max_zar_per_member</code>, the revenue report's net.</li>
 *   <li><b>What their wallet holds and a court costs.</b> These convert from the first at
 *       <code>credits_per_zar_regular</code> — shipped at <b>1.6</b> — or
 *       <code>credits_per_zar_league</code>, shipped at <b>2.4</b>.</li>
 * </ul>
 *
 * <p>
 * Writing both with one symbol means a wallet bought for R150 reads <code>R240.00</code>.
 * That was a live defect once, in six places at once, and the earlier fix for it is still
 * legible in this repository's history and in <code>e2e/money.spec.ts</code>. It is being
 * reintroduced <b>deliberately, on the owner's instruction</b>, and the reason it is
 * defensible is that a member cannot convert back: they never exchange a wallet for cash, so
 * the wallet is a statement of how much court time they can buy, and quoting court prices in
 * the club's own money is easier to read than quoting them in an invented unit.
 * </p>
 *
 * <p>
 * <b>What that costs, and the one rule it imposes.</b> The exchange rate is now invisible
 * everywhere except at the conversion itself. So the two places a member meets the boundary
 * — the top-up screen and the top-up email — <b>must state both legs in words</b>: what left
 * their card, and what arrived in their wallet. A club on 1.6 is giving a 60% bonus, and a
 * screen that renders "You pay R100.00 / You receive R160.00" without saying which is which
 * is the defect this paragraph exists to prevent. The residual risk the owner is accepting
 * is a member reading their wallet as withdrawable cash; that is a terms-and-conditions
 * matter, not an arithmetic one.
 * </p>
 *
 * <p>
 * <b>Why a module singleton and not a context.</b> The formatters are pure functions called
 * from <code>lib/*Copy.ts</code> — sentence builders that are not components and cannot read
 * a React context. A prop would make the symbol a property of whoever remembered to pass
 * one, which is exactly how six screens ended up each composing their own unit. The store is
 * written once, from the payload that already reaches every signed-in screen, by
 * {@link ../ClubUiProvider ClubUiProvider}.
 * </p>
 */

/** What a club gets when it has never said, and what an older API's silence means. */
export const DEFAULT_CURRENCY_SYMBOL = "R";

/**
 * A symbol, not an essay.
 *
 * <p>
 * Four characters covers every symbol in circulation — <code>R</code>, <code>R$</code>,
 * <code>CHF</code>, <code>US$</code>, <code>zł</code> — and the bound is not cosmetic: this
 * string is interpolated into an HTML email body and sits beside figures on screens whose
 * layout is already width-constrained.
 * </p>
 */
export const MAX_CURRENCY_SYMBOL_LENGTH = 4;

/**
 * Letters and currency signs only, 1 to {@link MAX_CURRENCY_SYMBOL_LENGTH} of them.
 *
 * <p>
 * <b>The rule is the API's, mirrored — never invented here.</b> `ecoSettings.ts` states why
 * at length: a screen that bounds a field more loosely than the server refuses it produces a
 * save that fails with a message nobody on the screen can act on, and one that bounds it
 * more tightly silently forbids a club a value the product supports. The server's rule is
 * <code>CurrencySymbol.IsAcceptable</code>.
 * </p>
 *
 * <p>
 * Admitting only <code>\p{L}</code> and <code>\p{Sc}</code> is what makes the value safe in
 * an HTML email without an escaping step: no angle bracket, no ampersand, no quote and no
 * control character can survive it. Digits are refused too, so "R50" cannot be saved as a
 * symbol and then printed in front of another number.
 * </p>
 */
const ACCEPTABLE = /^[\p{L}\p{Sc}]{1,4}$/u;

/** Whether a value is one the product can put in front of an amount. */
export function isAcceptableCurrencySymbol(raw: unknown): boolean {
  return typeof raw === "string" && ACCEPTABLE.test(raw.trim());
}

/**
 * The symbol a club will actually get — sanitised, or the default.
 *
 * <p>
 * <b>Unknown is never "some other symbol".</b> A field this client has never heard of, a
 * null, a number, an over-long string: every one means "the club has not chosen", which is
 * the default. The commonest case on the day this ships is <code>undefined</code>, from an
 * API that predates the key.
 * </p>
 *
 * <p>
 * Trimmed, because the owner wrote the setting as <code>"R "</code> — with the space that
 * separates it from the amount. That space is the formatter's business, not the value's, or
 * a club that types one gets a gap the layout never asked for.
 * </p>
 */
export function readCurrencySymbol(raw: unknown): string {
  return isAcceptableCurrencySymbol(raw) ? (raw as string).trim() : DEFAULT_CURRENCY_SYMBOL;
}

let current: string = DEFAULT_CURRENCY_SYMBOL;

/**
 * Point the formatters at this club's symbol.
 *
 * <p>
 * <b>Always assigns.</b> Passing an absent or unusable value resets to the default rather
 * than leaving the previous value standing — which is the whole of the cross-club hazard in
 * a module singleton. One tab can see two clubs: a sign-out, a second sign-in, an admin who
 * holds accounts at two. If "no symbol" meant "keep what you had", club B would inherit club
 * A's, and it would inherit it on the screens where money is shown.
 * </p>
 */
export function setClubCurrencySymbol(raw: unknown): void {
  current = readCurrencySymbol(raw);
}

/** The club's symbol, for a formatter. Never empty, never unsanitised. */
export function clubCurrencySymbol(): string {
  return current;
}

/** Back to the default. For tests, and for a signed-out screen. */
export function resetClubCurrencySymbol(): void {
  current = DEFAULT_CURRENCY_SYMBOL;
}

/**
 * What a symbol is called out loud.
 *
 * <p>
 * <b>This exists because the visible unit is now a symbol, and a symbol is not speakable.</b>
 * An <code>aria-label</code> REPLACES an element's contents as its accessible name, and a
 * screen reader handed "R240.00" announces the R as a letter — the same defect "cr" had,
 * which is why the wallet chip's label always spelt "credits" where the chip showed "cr".
 * </p>
 *
 * <p>
 * There is no general way to get "rand" from "R", so the currencies this product is likely
 * to meet are named and everything else answers null. <b>Null is the right answer, not a
 * guess</b>: a wrong noun — "240.00 dollars" to a club on tenge — is a lie a sighted member
 * would never be told, whereas no noun still leaves a sentence, because the sentence around
 * the number says what the number is.
 * </p>
 */
const SPOKEN_NAMES: Readonly<Record<string, string>> = {
  R: "rand",
  $: "dollars",
  "US$": "dollars",
  "€": "euros",
  "£": "pounds",
  CHF: "Swiss francs",
  "R$": "reais",
  kr: "kroner",
  "₹": "rupees",
};

export function spokenCurrencyName(symbol: string = clubCurrencySymbol()): string | null {
  return SPOKEN_NAMES[symbol] ?? null;
}
