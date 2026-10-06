import { useAuth } from "./useAuth";
import { BalanceContext } from "./useBalance";
import { useLiveBalance, type BalanceTransport, type LiveBalancePolicy } from "./liveBalance";

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
        frameMark: live.frameMark,
      }}
    >
      {children}
    </BalanceContext.Provider>
  );
}
