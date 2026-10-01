import { createContext, useContext } from "react";
import { useAuth } from "./auth";
import { minutesSpoken } from "./minutes";
import {
  useLiveBalance, type BalanceDelta, type BalanceTransport, type HeldFigures, type LiveBalancePolicy, type LiveState,
} from "./liveBalance";

/**
 * How low a balance has to be before the chip warns, in minutes. An hour: under it a member has
 * room for one short game at most, which is the moment "buy more" is worth a colour.
 */
export const LOW_BALANCE_MINUTES = 60;

/** Where a member buys minutes (P13 §3.1). The old `/wallet/topup` redirects here. */
export const BUY_MINUTES_PATH = "/wallet/buy";

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
   * The booking response carries <code>balance_after_minutes</code>, so the wallet GET that
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
  apply: (balanceMinutes: number) => void;
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
   * re-ran once the member had chosen their own password, and the header pill sat on "—"
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
