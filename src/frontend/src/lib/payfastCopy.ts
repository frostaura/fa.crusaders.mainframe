import { ApiError } from "./api";

/**
 * Settings › Money › PayFast (BM-4): the words for the club's own PayFast account. The API's codes are
 * `PayFastCredentialRules`' (and `not_configured` for a club with nothing stored); each is said as what
 * to fix, because a club whose account reads "not set up" sells no minutes online at all.
 */
export const PAYFAST_COPY = {
  title: "PayFast account",
  lede: "The club's own PayFast merchant account, where members' package payments are paid. Until it is set up"
    + " and correct, members are told online payment is not available and can still buy at the desk.",
  ready: "Set up. Members can pay for packages online.",
  notReady: "Not set up, so members cannot pay online yet:",
  environment: { test: "Sandbox (test payments only)", live: "Live (real payments)" } as Record<string, string>,
  merchantId: "Merchant ID",
  merchantIdHint: "8 digits, from PayFast's Settings › Integration.",
  merchantKey: "Merchant key",
  merchantKeyHint: "13 letters and digits, from the same page.",
  passphrase: "Passphrase",
  passphraseSet: "A passphrase is saved. Leave this empty to keep it.",
  passphraseUnset: "Type the passphrase set on PayFast's Settings › Integration (12 to 100 characters).",
  environmentLabel: "Payments are",
  notifyUrl: (url: string) => `PayFast tells the club about each payment at ${url}.`,
  edit: "Change the PayFast account",
  save: "Save the PayFast account",
  confirmTitle: "Save the PayFast account?",
  confirm: (live: boolean) => (live
    ? "Members' next payments go to this live account and take real money. Check the merchant ID matches the club's account."
    : "Members' next payments go to PayFast's sandbox: no real money moves, and nothing they buy is paid for."),
  saved: "PayFast account saved.",
  stillTrue: "the club's PayFast account is as it was",
  whether: "the PayFast account was saved",
};

/** One problem code, in the words of what to fix. */
export const PAYFAST_PROBLEM: Readonly<Record<string, string>> = {
  not_configured: "No PayFast account has been entered.",
  merchant_id_invalid: "The merchant ID must be the 8 digits PayFast shows.",
  merchant_key_invalid: "The merchant key must be the 13 letters and digits PayFast shows.",
  passphrase_required: "A passphrase is required: without one, anybody could forge a payment notice.",
  passphrase_too_short: "The passphrase must be at least 12 characters.",
  passphrase_too_long: "The passphrase must be at most 100 characters.",
  passphrase_invalid: "The passphrase cannot start or end with a space, hold a line break, or be a placeholder.",
  environment_invalid: "Choose sandbox or live.",
};

export function problemWords(code: string): string {
  return PAYFAST_PROBLEM[code] ?? `PayFast refused part of it (${code}).`;
}

/** A refused save, as the list of what to fix; null for any other failure. */
export function payFastRefusal(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== "payfast_credentials_invalid") return null;
  const problems = (e.payload as { problems?: unknown } | undefined)?.problems;
  if (!Array.isArray(problems) || problems.length === 0) return "PayFast's details are not right yet.";
  return problems.map((p) => problemWords(String(p))).join(" ");
}
