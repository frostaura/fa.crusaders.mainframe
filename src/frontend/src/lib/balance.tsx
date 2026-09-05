import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { endpoints, tokenStore } from "./api";
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

  const refresh = useCallback(async () => {
    if (auth.status !== "authenticated") return;
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
  }, [auth.status]);

  // Initial fetch + refresh on auth flip.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs wallet state with the auth lifecycle; loader sets its flag synchronously
    if (auth.status === "authenticated") refresh();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale balance on sign-out
    else setBalance(null);
  }, [auth.status, refresh]);

  // Refresh when the tab regains focus (covers manual top-ups in another tab).
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [auth.status, refresh]);

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
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    if (!tokenStore.get()) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const retryLater = () => {
      if (cancelled) return;
      reconnectTimer = setTimeout(() => { void connect(); }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };

    const connect = async () => {
      if (cancelled) return;
      let ticket: string;
      try {
        ({ ticket } = await endpoints.walletStreamTicket());
      } catch {
        // No ticket means no stream. A 401 has already been turned into a session-expired by
        // the api client; anything else is the club being unreachable, so back off and retry.
        retryLater();
        return;
      }
      if (cancelled) return;
      es = new EventSource(`/api/v1/wallet/stream?ticket=${encodeURIComponent(ticket)}`);
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { balance_credits: number };
          if (typeof msg.balance_credits === "number") setBalance(msg.balance_credits);
          backoffMs = 1000; // reset backoff on successful message
        } catch { /* keep-alive comments and malformed payloads are ignored */ }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        // Exponential backoff capped at 30s — covers network blips + container restarts.
        retryLater();
      };
    };

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [auth.status]);

  const apply = useCallback((balanceCredits: number) => setBalance(balanceCredits), []);

  return (
    <BalanceContext.Provider value={{ balance, loading, refresh, apply }}>
      {children}
    </BalanceContext.Provider>
  );
}
