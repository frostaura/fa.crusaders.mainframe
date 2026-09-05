import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { endpoints, setUnauthorizedHandler, tokenStore } from "./api";
import { loginWithPasskey as runPasskeyLogin } from "./webauthn";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
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
  logout: () => void;
  /** The forced change is done — clears the flag without a whole re-bootstrap. */
  passwordChanged: () => void;
  /**
   * True when a session was taken away underneath the member rather than never having existed —
   * an expiry, a revocation, an admin reset. `/login` says so instead of presenting a blank
   * sign-in form to someone who was signed in a second ago.
   */
  sessionExpired: boolean;
  clearSessionExpired: () => void;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [sessionExpired, setSessionExpired] = useState(false);
  const refreshTimer = useRef<number | null>(null);

  const refreshFromToken = useCallback(async () => {
    const t = tokenStore.get();
    if (!t) {
      setState({ status: "anonymous" });
      return;
    }
    try {
      const w = await endpoints.whoami();
      if (w.is_authenticated && w.user_id) {
        setState({ status: "authenticated", userId: w.user_id, isAdmin: w.is_admin, mustChangePassword: w.must_change_password === true });
      } else {
        // Token present but server doesn't recognise it — most likely expired or signed by an old key.
        // The member had a session and no longer does, which is a different thing from arriving
        // signed out, and /login says the different thing.
        tokenStore.clear();
        setSessionExpired(true);
        setState({ status: "anonymous" });
      }
    } catch {
      tokenStore.clear();
      setSessionExpired(true);
      setState({ status: "anonymous" });
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- session bootstrap on mount; no-token path resolves to anonymous synchronously
  useEffect(() => { refreshFromToken(); }, [refreshFromToken]);

  // Centralised session-expired handler — wired to the api client so any 401 on an authenticated
  // request flips the app back to anonymous and lets RequireAuth route the user to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
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
    tokenStore.clear();
    // Signing out on purpose is not losing a session; /login should not commiserate about it.
    setSessionExpired(false);
    setState({ status: "anonymous" });
  }, []);

  // The refresh call answers with the flag too, so this is belt-and-braces — but a member who
  // has just replaced their password should not be held on the change screen by a stale flag
  // while a background refresh decides otherwise.
  const passwordChanged = useCallback(() => {
    setState((s) => (s.status === "authenticated" ? { ...s, mustChangePassword: false } : s));
  }, []);

  const clearSessionExpired = useCallback(() => setSessionExpired(false), []);

  const value = useMemo<AuthCtx>(
    () => ({ ...state, login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink, logout, passwordChanged, sessionExpired, clearSessionExpired }),
    [state, login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink, logout, passwordChanged, sessionExpired, clearSessionExpired],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
