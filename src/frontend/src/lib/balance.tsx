import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { endpoints, tokenStore } from "./api";
import { useAuth } from "./auth";

type BalanceState = {
  balance: number | null;
  loading: boolean;
  refresh: () => Promise<void>;
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
  // reflect immediately. EventSource cannot send the Authorization header, so the JWT rides on
  // ?access_token=... — accepted on this path by JwtBearer.OnMessageReceived.
  useEffect(() => {
    if (auth.status !== "authenticated") return;
    const token = tokenStore.get();
    if (!token) return;
    let es: EventSource | null = null;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const connect = () => {
      if (cancelled) return;
      es = new EventSource(`/api/v1/wallet/stream?access_token=${encodeURIComponent(token)}`);
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
        if (cancelled) return;
        // Exponential backoff capped at 30s — covers network blips + container restarts.
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [auth.status]);

  return (
    <BalanceContext.Provider value={{ balance, loading, refresh }}>
      {children}
    </BalanceContext.Provider>
  );
}
