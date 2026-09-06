import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, endpoints, STREAM_SILENCE_MS, tokenStore } from "./api";
import { useAuth } from "./auth";

type BalanceState = {
  balance: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /**
   * Take a balance the server has just stated, without asking it again.
   *
   * <p>
   * The booking response carries <code>balance_after_credits</code>, so the wallet GET
   * that used to follow every booking asked a question already answered and put a second
   * round trip on the path between a member's tap and the screen changing. This is not an
   * optimistic guess — it is the server's own figure from the response that committed the
   * charge; the wallet stream and the next wallet read still reconcile it.
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

export function BalanceProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);
  /**
   * The forced-password-change gate is armed, so the API refuses `/wallet` and the stream
   * ticket with `403 password_change_required`.
   *
   * <p>
   * A session holding an admin-issued temporary password may reach nothing but the screen
   * that replaces it — `PasswordChangeGate` answers every other route `403
   * password_change_required`. The wallet is one of those routes, and the balance stream is
   * the one the client asks for again on a backoff, so the forced-change screen sat there
   * re-requesting a stream ticket against a refusal that is permanent by policy, printing a
   * console error each time on the one screen where a member can do nothing about it.
   * Nothing here runs until the gate clears; the effects re-run when it does.
   * </p>
   *
   * <p>
   * Carried as a DEPENDENCY for the same reason as in `profile.tsx`: `auth.status` stays
   * `"authenticated"` right through the forced change, so an effect keyed on it alone never
   * re-ran once the member had chosen their own password, and the header pill sat on "— cr"
   * until a manual reload. Keying on the flag also stops the wallet-stream ticket being retried
   * against a refusal that is permanent by policy while the gate is up.
   * </p>
   */
  const gated = auth.status === "authenticated" && auth.mustChangePassword;

  const refresh = useCallback(async () => {
    if (auth.status !== "authenticated" || gated) return;
    if (inflight.current) return;
    inflight.current = true;
    setLoading(true);
    try {
      const w = await endpoints.wallet();
      setBalance(w.balance_credits);
    } catch {
      // Silent — header pill simply won't update on transient failure.
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [auth.status, gated]);

  // Initial fetch + refresh on auth flip, and on the forced-change gate coming down.
  useEffect(() => {
    if (auth.status !== "authenticated") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale balance on sign-out
      setBalance(null);
      return;
    }
    if (!gated) refresh();
  }, [auth.status, gated, refresh]);

  // Refresh when the tab comes back — a manual top-up in another tab, a phone waking up in
  // a squash club. `visibilitychange` as well as `focus`, because a backgrounded PWA that is
  // brought forward never fires `focus` and is exactly the session most likely to have missed
  // a push while it was asleep.
  useEffect(() => {
    if (auth.status !== "authenticated" || gated) return;
    const onFocus = () => refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auth.status, gated, refresh]);

  // Live push: subscribe to /api/v1/wallet/stream so admin top-ups and other ledger movements
  // reflect immediately.
  //
  // Two things about this connection were wrong at once, and they compounded.
  //
  // The credential was the full access JWT, in the query string — `?access_token=…` — which
  // nginx's `location /api/` writes to its access log verbatim, on the first connect and again
  // on every reconnect. A fifteen-minute credential for the entire API, in a log file that
  // outlives it by months. It is a one-minute stream-only ticket now, minted by a POST.
  //
  // And the token was captured ONCE, outside `connect`, with `[auth.status]` as the only
  // dependency. `auth.status` does not change when the access token is refreshed, so every
  // reconnect re-used the token captured at sign-in; once that had expired the retry loop
  // settled into a permanent 30s poll of an endpoint answering 401, and the header pill froze
  // for the life of the tab. Any session older than the token lifetime that suffered a single
  // network blip — a phone waking up in a squash club — lost its live balance for good.
  // Minting the ticket inside `connect` is what fixes it: every attempt, including every
  // reconnect, authenticates with whatever the session holds *now*.
  //
  // The third thing wrong with it was that a stream can stop delivering WITHOUT failing.
  // The server's loop used to abandon its pending read on every keep-alive, so from ~25s
  // into a page's life every published balance was swallowed while the socket stayed open —
  // no `onerror`, no `requestfailed`, nothing for the backoff above to react to, and a
  // member watching a stale figure until they reloaded. The server is fixed, but a client
  // whose only liveness signal is `onerror` is trusting the other end to fail loudly, and
  // this one did not. The keep-alive is a named `ping` event now, so silence is observable:
  // if nothing arrives for STREAM_SILENCE_MS the connection is dropped, the balance is
  // re-read over plain HTTP, and the stream is reopened — which also re-syncs on connect.
  useEffect(() => {
    // Nothing to subscribe to while the forced-change gate is up: the ticket endpoint answers
    // 403 by policy, so retrying it is a loop that can never succeed. The gate coming down is
    // a dependency, so the stream opens the moment the member has their own password.
    if (auth.status !== "authenticated" || gated) return;
    if (!tokenStore.get()) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const clearSilenceTimer = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    };

    const retryLater = () => {
      if (cancelled) return;
      reconnectTimer = setTimeout(() => { void connect(); }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };

    const dropAndRetry = () => {
      clearSilenceTimer();
      es?.close();
      es = null;
      // Exponential backoff capped at 30s — covers network blips + container restarts.
      retryLater();
    };

    /** Restarted by every byte the stream delivers; firing means the stream has gone quiet. */
    const heardFrom = () => {
      clearSilenceTimer();
      silenceTimer = setTimeout(() => {
        void refresh();
        dropAndRetry();
      }, STREAM_SILENCE_MS);
    };

    const connect = async () => {
      if (cancelled) return;
      let ticket: string;
      try {
        ({ ticket } = await endpoints.walletStreamTicket());
      } catch (err) {
        // A 403 is a policy, not a blip — the forced-password-change gate answers every
        // route but its own, and no amount of backing off changes that answer. Stop asking;
        // this effect re-runs by itself the moment the gate clears.
        if (err instanceof ApiError && err.status === 403) return;
        // Otherwise: no ticket means no stream. A 401 has already been turned into a
        // session-expired by the api client; anything else is the club being unreachable.
        retryLater();
        return;
      }
      if (cancelled) return;
      es = new EventSource(`/api/v1/wallet/stream?ticket=${encodeURIComponent(ticket)}`);
      heardFrom();
      es.onopen = () => { backoffMs = 1000; heardFrom(); };
      es.onmessage = (e) => {
        heardFrom();
        try {
          const msg = JSON.parse(e.data) as { balance_credits: number };
          if (typeof msg.balance_credits === "number") setBalance(msg.balance_credits);
          backoffMs = 1000; // reset backoff on successful message
        } catch { /* malformed payloads are ignored */ }
      };
      // The keep-alive carries no balance; all it proves is that the stream is still ours.
      es.addEventListener("ping", heardFrom);
      es.onerror = dropAndRetry;
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearSilenceTimer();
      es?.close();
    };
  }, [auth.status, gated, refresh]);

  const apply = useCallback((balanceCredits: number) => setBalance(balanceCredits), []);

  return (
    <BalanceContext.Provider value={{ balance, loading, refresh, apply }}>
      {children}
    </BalanceContext.Provider>
  );
}
