import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, endpoints, setUnauthorizedHandler, tokenStore } from "./api";
import { loginWithPasskey as runPasskeyLogin } from "./webauthn";
import { clearOfflineCache } from "./pwa";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  /**
   * There is a stored token and the club cannot be reached to say anything about it.
   *
   * <p>
   * This state exists because the bootstrap probe used to treat "the server says this token
   * is bad" and "I could not reach the server" as the same event, and both deleted the token.
   * One 502 from the gateway — the few seconds a container spends restarting during a
   * redeploy — therefore signed out every member and admin on the site permanently: the token
   * was gone from storage, so restoring the backend and reloading still landed on /login.
   * </p>
   *
   * <p>
   * Only an authentication refusal may clear a session. An outage is a wait, not a sign-out,
   * so the token is kept and the probe retried with backoff until the club answers.
   * </p>
   */
  | { status: "offline" }
  | {
      status: "authenticated"; userId: string; isAdmin: boolean;
      /**
       * The session is holding an admin-issued temporary password and can reach nothing but the
       * screen that replaces it. The API enforces this regardless (`PasswordChangeGate`); this
       * flag is only what lets the app route there instead of letting every screen fail with a
       * 403 the member cannot act on.
       */
      mustChangePassword: boolean;
    };

type AuthCtx = AuthState & {
  login: (email: string, password: string) => Promise<void>;
  loginWithPasskey: () => Promise<void>;
  loginAsSeededAdmin: () => Promise<void>;
  setSessionFromMagicLink: (token: string) => Promise<void>;
  /** Resolves once the server has been told; the local session is gone before it resolves. */
  logout: () => Promise<void>;
  /** The forced change is done — clears the flag without a whole re-bootstrap. */
  passwordChanged: () => void;
  /**
   * True when a session was taken away underneath the member rather than never having existed —
   * an expiry, a revocation, an admin reset. `/login` says so instead of presenting a blank
   * sign-in form to someone who was signed in a second ago.
   */
  sessionExpired: boolean;
  clearSessionExpired: () => void;
  /**
   * Re-run the bootstrap probe immediately, cancelling the backoff.
   *
   * <p>
   * Returns the probe's own promise, and that return value is load-bearing rather than tidy:
   * the outage screen's "Try again now" is the only control it offers, and against a stalled
   * backend it sat in one state for the full 25 seconds — not disabled, no `aria-busy`, no
   * label change. A member presses the one thing they are given, nothing happens, and they
   * press it again. There is nothing else on this side that knows when the attempt is over.
   * </p>
   */
  retryConnection: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

// Decode a JWT payload (best-effort — invalid tokens just return null).
function decodeExp(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const payload = JSON.parse(json) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch { return null; }
}

// Refresh a minute before expiry, with a sensible floor and ceiling so we don't either spin or
// drift past the JWT lifetime.
function nextRefreshDelayMs(token: string): number {
  const exp = decodeExp(token);
  if (!exp) return 10 * 60 * 1000;
  const remainingMs = exp * 1000 - Date.now();
  const target = remainingMs - 60_000;
  return Math.max(15_000, Math.min(target, 12 * 60 * 1000));
}

/**
 * Did the club actually refuse this token, or did it never answer?
 *
 * <p>
 * Only the first may end a session. A 5xx, a timeout, a refused connection and an HTML error
 * page from the gateway all arrive at the same `catch` and none of them is evidence about the
 * token. A 401 is — and so is a 200 whose body says `is_authenticated: false`, which the caller
 * handles separately because it is a successful response rather than a thrown one.
 * </p>
 */
function isAuthRefusal(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/** Retry schedule for the bootstrap probe while the club is unreachable: 1s, 2s, 4s … 30s. */
function nextProbeDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [sessionExpired, setSessionExpired] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const probeTimer = useRef<number | null>(null);
  const probeAttempt = useRef(0);
  // The retry re-enters the probe, and a `useCallback` cannot name itself in its own body.
  // A ref to the latest one keeps the recursion honest without re-creating the callback.
  const probeAgain = useRef<() => void>(() => {});

  /**
   * A session taken away rather than given up: an expiry, a revocation, an admin reset. It has
   * to drop the offline caches for the same reason the sign-out button does — this is the way
   * a session on a shared club device actually ends most of the time, because the member walks
   * away rather than signing out.
   */
  const endSession = useCallback(() => {
    tokenStore.clear();
    void clearOfflineCache();
    setSessionExpired(true);
    setState({ status: "anonymous" });
  }, []);

  const refreshFromToken = useCallback(async () => {
    const t = tokenStore.get();
    if (!t) {
      setState({ status: "anonymous" });
      return;
    }
    try {
      const w = await endpoints.whoami();
      if (w.is_authenticated && w.user_id) {
        probeAttempt.current = 0;
        setState({ status: "authenticated", userId: w.user_id, isAdmin: w.is_admin, mustChangePassword: w.must_change_password === true });
      } else {
        // Token present but server doesn't recognise it — most likely expired or signed by an old key.
        // The member had a session and no longer does, which is a different thing from arriving
        // signed out, and /login says the different thing.
        endSession();
      }
    } catch (err) {
      if (isAuthRefusal(err)) {
        endSession();
        return;
      }
      // The club is down, not the session. Keep the token — a redeploy must not cost every
      // signed-in member their session — and keep asking until somebody answers.
      setState({ status: "offline" });
      const delay = nextProbeDelayMs(probeAttempt.current);
      probeAttempt.current += 1;
      if (probeTimer.current) window.clearTimeout(probeTimer.current);
      probeTimer.current = window.setTimeout(() => { probeAgain.current(); }, delay);
    }
  }, [endSession]);

  useEffect(() => { probeAgain.current = refreshFromToken; }, [refreshFromToken]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- session bootstrap on mount; no-token path resolves to anonymous synchronously
  useEffect(() => { refreshFromToken(); }, [refreshFromToken]);

  useEffect(() => () => { if (probeTimer.current) window.clearTimeout(probeTimer.current); }, []);

  // Centralised session-expired handler — wired to the api client so any 401 on an authenticated
  // request flips the app back to anonymous and lets RequireAuth route the user to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      // Same reasoning as endSession: the session is over, so nothing this browser cached
      // while it was alive may survive it.
      void clearOfflineCache();
      setSessionExpired(true);
      setState({ status: "anonymous" });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // While authenticated, proactively refresh the access token before it expires so an active
  // session never breaks under the user.
  useEffect(() => {
    if (state.status !== "authenticated") return;
    let cancelled = false;
    const schedule = (token: string) => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const r = await endpoints.refresh();
          tokenStore.set(r.access_token);
          if (!cancelled) schedule(r.access_token);
        } catch {
          // 401 will already have been handled by setUnauthorizedHandler; nothing more to do here.
        }
      }, nextRefreshDelayMs(token));
    };
    const t = tokenStore.get();
    if (t) schedule(t);
    return () => {
      cancelled = true;
      if (refreshTimer.current) { window.clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    };
  }, [state.status]);

  /** Ask the club again right now — what the "Try again" button on the outage screen does. */
  const retryConnection = useCallback(() => {
    if (probeTimer.current) { window.clearTimeout(probeTimer.current); probeTimer.current = null; }
    probeAttempt.current = 0;
    // Returned, not fire-and-forget. See the type above.
    return refreshFromToken();
  }, [refreshFromToken]);

  const login = useCallback(async (email: string, password: string) => {
    const r = await endpoints.login(email, password);
    tokenStore.set(r.access_token);
    setSessionExpired(false);
    setState({ status: "authenticated", userId: r.user_id, isAdmin: r.is_admin, mustChangePassword: r.must_change_password === true });
  }, []);

  const loginWithPasskey = useCallback(async () => {
    const r = await runPasskeyLogin();
    tokenStore.set(r.access_token);
    setSessionExpired(false);
    setState({ status: "authenticated", userId: r.user_id, isAdmin: r.is_admin, mustChangePassword: r.must_change_password === true });
  }, []);

  const loginAsSeededAdmin = useCallback(async () => {
    const r = await endpoints.devAdminLogin();
    tokenStore.set(r.access_token);
    setSessionExpired(false);
    setState({ status: "authenticated", userId: r.user_id, isAdmin: r.is_admin, mustChangePassword: r.must_change_password === true });
  }, []);

  const setSessionFromMagicLink = useCallback(async (token: string) => {
    const r = await endpoints.magicLink(token);
    tokenStore.set(r.access_token);
    setSessionExpired(false);
    setState({ status: "authenticated", userId: r.user_id, isAdmin: r.is_admin, mustChangePassword: r.must_change_password === true });
  }, []);

  const logout = useCallback(() => {
    // Tell the server first, while the token is still in storage for the client to send: the
    // API puts that jti on its revocation list, so the credential stops working rather than
    // merely stopping being presented. A failure here is not worth blocking the sign-out —
    // the local half must happen either way — but it is worth attempting before the local half
    // rather than after, because after, there is nothing left to authenticate the call with.
    const ending = endpoints.logout().catch(() => undefined);
    tokenStore.clear();
    // A club phone is a shared device; the next person to sign in must inherit nothing this
    // browser stored while the last session was alive.
    void clearOfflineCache();
    // Signing out on purpose is not losing a session; /login should not commiserate about it.
    setSessionExpired(false);
    setState({ status: "anonymous" });
    return ending;
  }, []);

  // The refresh call answers with the flag too, so this is belt-and-braces — but a member who
  // has just replaced their password should not be held on the change screen by a stale flag
  // while a background refresh decides otherwise.
  const passwordChanged = useCallback(() => {
    setState((s) => (s.status === "authenticated" ? { ...s, mustChangePassword: false } : s));
  }, []);

  const clearSessionExpired = useCallback(() => setSessionExpired(false), []);

  const value = useMemo<AuthCtx>(
    () => ({ ...state, login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink, logout, passwordChanged, sessionExpired, clearSessionExpired, retryConnection }),
    [state, login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink, logout, passwordChanged, sessionExpired, clearSessionExpired, retryConnection],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
