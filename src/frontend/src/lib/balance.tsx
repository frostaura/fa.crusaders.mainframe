import { createContext, useContext } from "react";
import { useAuth } from "./auth";
import { useLiveBalance, type BalanceDelta, type BalanceTransport, type LiveState } from "./liveBalance";

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
 * <b>The signature is additive.</b> `walletLabel(balance, loading)` is what a dozen callers and
 * `wallet-chip-a11y.test.tsx` already pass; the third argument carries the honesty suffix and
 * defaults to saying nothing.
 * </p>
 */
export function walletLabel(balance: number | null, loading: boolean, state?: LiveState): string {
  if (balance === null) return loading ? "Wallet balance, loading" : "Wallet balance unavailable";
  const amount = `${balance.toFixed(2)} credits`;
  // Never claim a figure is live when the stream has gone and a 30-second poll is standing in
  // for it. A confident stale number is the defect the degraded state exists to close.
  const stale = state === "degraded" ? " This figure is checked every 30 seconds." : "";
  if (balance <= 0) return `Wallet balance 0 credits. You can't book until you top up. Tap to top up.${stale}`;
  if (balance < LOW_BALANCE_CREDITS) return `Wallet balance ${amount}, running low. Tap to top up.${stale}`;
  return `Wallet balance ${amount}. Tap to top up.${stale}`;
}

/**
 * Where the chip goes when it is tapped — and at zero this is NOT `/wallet`.
 *
 * At zero the ledger is empty or one row and the only useful control is one more tap away, so
 * the chip that says "you cannot book" led to a screen that does nothing about it.
 */
export function walletHref(balance: number | null): string {
  return balance !== null && balance <= 0 ? "/wallet/topup" : "/wallet";
}

/** Which of the three looks the chip wears. Three states, three looks — not two. */
export function walletTone(balance: number | null): "zero" | "low" | "fine" {
  if (balance !== null && balance <= 0) return "zero";
  if (balance !== null && balance < LOW_BALANCE_CREDITS) return "low";
  return "fine";
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
  refresh: () => Promise<void>;
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

export function BalanceProvider({ children, transport }: {
  children: React.ReactNode;
  /** For tests. Production uses the SSE transport, which is the programme's settled choice. */
  transport?: BalanceTransport;
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
    transport,
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
        refresh: live.refresh,
        apply: live.apply,
      }}
    >
      {children}
    </BalanceContext.Provider>
  );
}
