/**
 * The club's currency symbol — what it is, and the one thing it is deliberately NOT.
 *
 * <p>
 * <b>The decision, stated here because the code is where it has to hold.</b> The owner asked
 * for the <code>cr</code> suffix to be replaced by a configurable symbol that precedes the
 * amount, defaulting to <code>R</code>. This product renders two different quantities and
 * only one of them is money:
 * </p>
 *
 * <ul>
 *   <li><b>Rand</b> — what a member hands PayFast. <code>topup_block_zar</code>,
 *       <code>topup_max_zar_per_member</code>, the revenue card's <code>net_zar</code>.
 *       This IS money, and this symbol is its symbol.</li>
 *   <li><b>Credits</b> — the wallet balance and what a slot costs. A member pays R100 and
 *       receives <code>credits_per_zar_regular</code> × 100 credits, which ships at
 *       <b>1.6</b>. Credits are the unit of account (<code>CLAUDE.md</code>), and a credit
 *       figure wearing a rand sign is a money-correctness defect, not a copy choice: at the
 *       shipped rate a 240-credit wallet rendered "R240.00" overstates the member's rand
 *       position by 60%, and at the League rate of 2.4 by 140%.</li>
 * </ul>
 *
 * <p>
 * That second bullet is not a hypothetical. It shipped, in six places at once, and is
 * recorded in the header of {@link ./utils.ts formatCredits}, in the header of
 * <code>EmailTemplates.Cr</code> on the backend, and in the existence of
 * <code>e2e/money.spec.ts</code>, whose entire job is to assert that a credit figure never
 * carries an R. <b>So this symbol reaches rand and stops there, and the credit unit keeps a
 * unit of its own.</b> The ask has been narrowed, deliberately and visibly; a club that
 * genuinely wants its credits shown as rand wants <code>credits_per_zar_* = 1</code> first,
 * and that is the founder's call to make, not this file's.
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
