import { createContext, useContext } from "react";
import { useAuth } from "./auth";
import {
  useLiveBalance, type BalanceDelta, type BalanceTransport, type HeldFigures, type LiveBalancePolicy, type LiveState,
} from "./liveBalance";

/** How low a balance has to be before the chip warns, in credits. Mirrors the amber threshold. */
export const LOW_BALANCE_CREDITS = 50;

/**
 * What a screen reader says for the wallet chip.
 *
 * <p>
 * Spelled out rather than reusing `formatCredits`, whose "cr" is an abbreviation a screen
 * reader reads as letters. And the low-balance state is spoken, because it is otherwise
 * carried entirely by the chip's colour.
 * </p>
 *
 * <p>
 * <b>Zero got its own arm, and its absence was a measured defect.</b> There were two arms, and
 * at exactly 0.00 a member was told their balance was "running low". It is not low, it is
 * empty, and they cannot book anything at all — while the grid went on offering them 31 green
 * "Available" cells. The same two-arm reading made 0.00 and 49.99 the identical amber.
 * </p>
 *
 * <p>
 * <b>The zero arm states the balance it is describing, and a debt is not zero.</b> The arm was
 * written as the literal sentence "Wallet balance 0 credits", which is true of exactly one of
 * the balances that reach it. `walletTone` classifies a NEGATIVE balance as `"zero"` and is
 * right to — see the reasoning on `walletTone` itself — but "emptier than empty" is a statement
 * about what the member can DO, not about what they have. A member at −25.00 credits was told,
 * in the only place this chip says a number out loud, that their balance was 0. It is not:
 * they owe the club money, the visible chip beside the label has been rendering "-25.00 cr" all
 * along, and a member who tops up the price of one slot on the strength of that sentence still
 * cannot book. The direction is carried by a WORD rather than by a minus sign, for the same
 * reason this label spells out "credits" instead of reusing the "cr" abbreviation: a screen
 * reader given "−25.00" announces anything from "twenty five" to "dash twenty five".
 * </p>
 *
 * <p>
 * <b>The signature is additive.</b> `walletLabel(balance, loading)` is what a dozen callers and
 * `wallet-chip-a11y.test.tsx` already pass; the third argument carries the honesty suffix and
 * defaults to saying nothing.
 * </p>
 */
export function walletLabel(
  balance: number | null, loading: boolean, state?: LiveState, heldCredits?: number, owedBackCredits?: number,
): string {
  if (balance === null) return loading ? "Wallet balance, loading" : "Wallet balance unavailable";
  // D11 §3a — the held part rides after the figure, in words, and only when there is one: the
  // chip shows the whole balance, and a member refused a booking with it should hear why.
  // P11 — so does what is owed back to partners, which the next credit in pays first.
  const held = `${partSuffix(heldCredits, "held for partners")}${partSuffix(owedBackCredits, "owed back to partners")}`;
  const amount = `${balance.toFixed(2)} credits${held}`;
  // Never claim a figure is live when the stream has gone and a 30-second poll is standing in
  // for it. A confident stale number is the defect the degraded state exists to close.
  const stale = state === "degraded" ? " This figure is checked every 30 seconds." : "";
  // Through `walletTone`, so the sentence a screen-reader user hears and the colour a sighted
  // one sees can never disagree — which they did at 0.004, where this said "running low" over
  // a chip the wallet page was calling empty.
  const tone = walletTone(balance);
  if (tone === "zero") return `Wallet balance ${emptyAmount(balance)}${held}. You can't book until you top up. Tap to top up.${stale}`;
  if (tone === "low") return `Wallet balance ${amount}, running low. Tap to top up.${stale}`;
  return `Wallet balance ${amount}. Tap to top up.${stale}`;
}

/** ", 20.00 held for partners" — or nothing, when there is none of it. */
function partSuffix(credits: number | undefined, what: string): string {
  return credits && credits > 0 ? `, ${credits.toFixed(2)} ${what}` : "";
}

/**
 * The figure, and its direction, for a balance the tone rule has called `"zero"`.
 *
 * <p>
 * Rounded to two places FIRST, because the whole of this product's zero rule is about the
 * number the member can see: 0.004 is "0.00 credits" and not a hair of credit, and −0.001 is
 * "0.00 credits" and not a debt of nothing. Rounding first is also what keeps the negated zero
 * out of the sentence — `(-0.001).toFixed(2)` is the string "-0.00", and a spoken "minus zero
 * point zero zero credits" is the same class of defect `formatMoney` and `formatSignedCredits`
 * each carry their own guard against.
 * </p>
 */
function emptyAmount(balance: number): string {
  const shown = Number(balance.toFixed(2));
  const magnitude = `${Math.abs(shown).toFixed(2)} credits`;
  return shown < 0 ? `${magnitude} overdrawn` : magnitude;
}

/**
 * Where the chip goes when it is tapped — and at zero this is NOT `/wallet`.
 *
 * At zero the ledger is empty or one row and the only useful control is one more tap away, so
 * the chip that says "you cannot book" led to a screen that does nothing about it.
 */
export function walletHref(balance: number | null): string {
  return walletTone(balance) === "zero" ? "/wallet/topup" : "/wallet";
}

/** The three states a balance can be in. `null` — not read yet — is not one of them. */
export type WalletTone = "zero" | "low" | "fine";

/**
 * How near zero counts as zero. Half a cent of a credit — the smallest movement that can
 * change what `toFixed(2)` paints.
 */
const ROUNDS_TO_ZERO = 0.005;

/**
 * Which of the three states a balance is in. <b>The only place the question is asked.</b>
 *
 * <p>
 * Three lanes each wrote this rule and they disagreed. The chip asked `balance <= 0`; the
 * wallet page asked `< 0.005`; the grid's empty-wallet banner asked `balance > 0`. At 0.004
 * credits a member therefore saw a green chip reading "0.00 cr", a red wallet card telling
 * them they could not book, and a grid with no banner on it — three screens, each written by
 * somebody who HAD thought about the rounding case, each having thought about it alone.
 * </p>
 *
 * <p>
 * <b>Not `=== 0`, and not `<= 0` either.</b> `=== 0` misses a negative balance, which is a
 * real state: the settlement model posts a late reversal as two NEW rows rather than an edit,
 * and says in so many words that the balance may go negative. That is emptier than empty, not
 * a different kind of thing. `<= 0` misses the other end — 0.004 is not `<= 0`, renders as
 * "0.00 credits" and buys nothing, since a slot costs fifty. What the member can SEE is two
 * decimal places, so the rule has to be about the same number they are looking at.
 * </p>
 *
 * <p>
 * <b>`null` is UNKNOWN, and answers `fine`.</b> A wallet read that has not landed is not an
 * empty wallet; a product that shouted "no credits" at a slow network would be wrong more
 * often than right, and would send a member who has money to a top-up form.
 * </p>
 */
export function walletTone(balance: number | null): WalletTone {
  if (balance === null) return "fine";
  if (balance < ROUNDS_TO_ZERO) return "zero";
  return balance < LOW_BALANCE_CREDITS ? "low" : "fine";
}

type BalanceState = {
  balance: number | null;
  loading: boolean;
  /** Four states, not two. `loading` != `degraded` != `unavailable`. */
  state: LiveState;
  lastConfirmedAt: number | null;
  /** The most recent movement, for the chip's count-up and flyout. */
  delta: BalanceDelta | null;
  clearDelta: () => void;
  /**
   * D11 §3a — what of the balance is held for partners, the SPENDABLE figure every spend
   * decision and every "balance after" reads, and when the hold lifts. Null until a figure has
   * arrived; `held` 0 against an API that predates it.
   */
  held: HeldFigures | null;
  /** P11 — the inbox's unread count as the stream last pushed it (null until one arrives). */
  unreadCount: number | null;
  noteUnread: (count: number) => void;
  /**
   * Re-read the wallet. `{ expectSelf: true }` on the paths where the PAGE has already told
   * the member what happened, so the chip does not announce the same movement a second time —
   * see `useLiveBalance.refresh`. Bare, for the reads nobody asked for (focus, visibility).
   */
  refresh: (options?: { expectSelf?: boolean }) => Promise<void>;
  /**
   * Take a balance the server has just stated, without asking it again.
   *
   * <p>
   * The booking response carries <code>balance_after_credits</code>, so the wallet GET that
   * used to follow every booking asked a question already answered and put a second round trip
   * between a member's tap and the screen changing. This is not an optimistic guess — it is
   * the server's own figure from the response that committed the charge; the wallet stream and
   * the next wallet read still reconcile it.
   * </p>
   *
   * <p>
   * It also marks the next movement as this tab's own, so the chip does not raise a toast
   * about a booking the member has already been told about.
   * </p>
   */
  apply: (balanceCredits: number) => void;
};

const BalanceContext = createContext<BalanceState | null>(null);

export function useBalance(): BalanceState {
  const ctx = useContext(BalanceContext);
  if (!ctx) throw new Error("useBalance must be used inside <BalanceProvider>");
  return ctx;
}

export function BalanceProvider({ children, transport, policy }: {
  children: React.ReactNode;
  /** For tests. Production uses the SSE transport, which is the programme's settled choice. */
  transport?: BalanceTransport;
  /**
   * For tests. The same state machine with its waits shortened.
   *
   * <p>
   * A seam rather than fake timers everywhere: the reconnect, the idle close and the poll are
   * three interleaved schedules, and a test that advances a fake clock through all three is
   * asserting about its own arithmetic as much as about the machine. Shortening the policy
   * keeps the machine identical and makes the test's waits real.
   * </p>
   */
  policy?: LiveBalancePolicy;
}) {
  const auth = useAuth();
  /**
   * The forced-password-change gate is armed, so the API refuses `/wallet` and the stream
   * ticket with `403 password_change_required`.
   *
   * <p>
   * A session holding an admin-issued temporary password may reach nothing but the screen that
   * replaces it. The wallet is one of those routes, and the balance stream is the one the
   * client asks for again on a backoff, so the forced-change screen sat there re-requesting a
   * stream ticket against a refusal that is permanent by policy, printing a console error each
   * time on the one screen where a member can do nothing about it.
   * </p>
   *
   * <p>
   * Carried as a DEPENDENCY for the same reason as in `profile.tsx`: `auth.status` stays
   * `"authenticated"` right through the forced change, so a hook keyed on it alone never
   * re-ran once the member had chosen their own password, and the header pill sat on "— cr"
   * until a manual reload.
   * </p>
   */
  const gated = auth.status === "authenticated" && auth.mustChangePassword;
  const live = useLiveBalance({
    enabled: auth.status === "authenticated" && !gated,
    // D1/D2 — whose balance it is. A sign-in changes this without changing `enabled`.
    identity: auth.status === "authenticated" ? auth.userId : null,
    transport,
    policy,
  });

  return (
    <BalanceContext.Provider
      value={{
        balance: live.balance,
        loading: live.loading,
        state: live.state,
        lastConfirmedAt: live.lastConfirmedAt,
        delta: live.delta,
        clearDelta: live.clearDelta,
        held: live.heldFigures,
        unreadCount: live.unreadCount,
        noteUnread: live.noteUnread,
        refresh: live.refresh,
        apply: live.apply,
      }}
    >
      {children}
    </BalanceContext.Provider>
  );
}
