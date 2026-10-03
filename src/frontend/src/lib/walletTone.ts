/**
 * The wallet's three tones, with no imports, so copy modules and Playwright specs (which load
 * `lib/walletCopy.ts` in Node, where the auth module's `localStorage` read at load would throw)
 * can ask the question without pulling in the live-balance and auth chain. Nothing re-exports
 * them: import from here.
 */

/**
 * How low a balance has to be before the chip warns, in minutes. An hour: under it a member has
 * room for one short game at most, which is the moment "buy more" is worth a colour.
 */
export const LOW_BALANCE_MINUTES = 60;

/** The three states a balance can be in. `null` — not read yet — is not one of them. */
export type WalletTone = "zero" | "low" | "fine";

/**
 * Which of the three states a balance is in. <b>The only place the question is asked.</b>
 *
 * <p>
 * Three lanes each once wrote this rule and they disagreed, so a member saw a green chip, a red
 * wallet card and a grid with no banner for the same balance. It lives here, once.
 * </p>
 *
 * <p>
 * <b>Zero is "less than one whole minute", not `=== 0`.</b> A negative balance is a real state
 * (a late reversal posts new rows and may take a balance below zero) and is emptier than empty.
 * The ledger holds whole minutes, so anything under one is nothing to book with; a fraction a
 * caller let through is read the way `<Minutes>` paints it — truncated.
 * </p>
 *
 * <p>
 * <b>`null` is UNKNOWN, and answers `fine`.</b> A wallet read that has not landed is not an
 * empty wallet; shouting "no minutes" at a slow network would send a member who has time on
 * their wallet to the buy screen.
 * </p>
 */
export function walletTone(balance: number | null): WalletTone {
  if (balance === null) return "fine";
  const whole = Math.trunc(balance);
  if (whole < 1) return "zero";
  return whole < LOW_BALANCE_MINUTES ? "low" : "fine";
}
