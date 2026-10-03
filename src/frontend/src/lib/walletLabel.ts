import { BUY_MINUTES_PATH, minutesSpoken } from "./minutes";
import type { LiveState } from "./liveBalance";
import { walletTone } from "./walletTone";

/*
 * The wallet chip's words and destination, with no React and no session chain, so copy modules
 * and Node-side specs can use them. `balance.tsx` owns the live figure.
 */

/**
 * What a screen reader says for the wallet chip.
 *
 * <p>
 * Spoken through `minutesSpoken` ("7 hours 52 minutes"), never the compact "7 h 52 min" the eye
 * reads: a screen reader says "h" as a letter. And the low-balance state is spoken, because it is
 * otherwise carried entirely by the chip's colour.
 * </p>
 *
 * <p>
 * <b>Zero got its own arm, and its absence was a measured defect.</b> There were two arms, and
 * at exactly zero a member was told their balance was "running low". It is not low, it is
 * empty, and they cannot book anything at all — while the grid went on offering them green
 * "Available" cells.
 * </p>
 *
 * <p>
 * <b>The zero arm states the balance it is describing, and a debt is not zero.</b> `walletTone`
 * classifies a NEGATIVE balance as `"zero"` and is right to, but "emptier than empty" is about
 * what the member can DO, not what they have. A member 25 minutes overdrawn was once told their
 * balance was 0. The direction is carried by a WORD ("overdrawn") rather than a minus sign, which
 * a screen reader announces as anything from "minus" to "dash".
 * </p>
 *
 * <p>
 * <b>The signature is additive.</b> `walletLabel(balance, loading)` is what most callers pass;
 * the later arguments carry the honesty suffix and the parts set aside for partners.
 * </p>
 */
export function walletLabel(
  balance: number | null, loading: boolean, state?: LiveState, heldMinutes?: number, owedBackMinutes?: number,
): string {
  if (balance === null) return loading ? "Wallet balance, loading" : "Wallet balance unavailable";
  // D11 §3a — the held part rides after the figure, in words, and only when there is one.
  // P11 — so does what is owed back to partners, which the next minutes in pay first.
  const held = `${partSuffix(heldMinutes, "held for partners")}${partSuffix(owedBackMinutes, "owed back to partners")}`;
  const amount = `${minutesSpoken(balance)}${held}`;
  // Never claim a figure is live when the stream has gone and a 30-second poll is standing in
  // for it. A confident stale number is the defect the degraded state exists to close.
  const stale = state === "degraded" ? " This figure is checked every 30 seconds." : "";
  // Through `walletTone`, so the sentence a screen-reader user hears and the colour a sighted
  // one sees can never disagree.
  const tone = walletTone(balance);
  if (tone === "zero") return `Wallet balance ${emptyAmount(balance)}${held}. You can't book until you buy minutes. Tap to buy minutes.${stale}`;
  if (tone === "low") return `Wallet balance ${amount}, running low. Tap to buy minutes.${stale}`;
  return `Wallet balance ${amount}. Tap to buy minutes.${stale}`;
}

/** ", 20 minutes held for partners" — or nothing, when there is none of it. */
function partSuffix(minutes: number | undefined, what: string): string {
  return minutes && minutes > 0 ? `, ${minutesSpoken(minutes)} ${what}` : "";
}

/**
 * The figure, and its direction, for a balance the tone rule has called `"zero"`: "0 minutes", or
 * "25 minutes overdrawn". Whole minutes first (`minutesSpoken` truncates toward zero), so a
 * fraction a caller let through can never be spoken as a debt of nothing.
 */
function emptyAmount(balance: number): string {
  const whole = Math.trunc(balance);
  return whole < 0 ? `${minutesSpoken(-whole)} overdrawn` : minutesSpoken(0);
}

/**
 * Where the chip goes when it is tapped — and at zero this is NOT `/wallet`.
 *
 * At zero the ledger is empty or one row and the only useful control is one more tap away, so
 * the chip that says "you cannot book" led to a screen that does nothing about it.
 */
export function walletHref(balance: number | null): string {
  return walletTone(balance) === "zero" ? BUY_MINUTES_PATH : "/wallet";
}
