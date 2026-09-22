import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, endpoints, setPasswordChangeRequiredHandler, setUnauthorizedHandler, TOKEN_KEY, tokenStore } from "./api";
import { loginWithPasskey as runPasskeyLogin } from "./webauthn";
import { clearOfflineCache } from "./pwa";
import { forgetLastKnown } from "./lastKnown";
import { forgetClubZone } from "./clubZone";

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

/**
 * Another tab signed out — or had its session revoked — and this one is still on screen.
 *
 * <p>
 * `localStorage` is shared by every tab on the origin, and a `storage` event fires in all the
 * OTHERS, never in the tab that made the change, which is exactly the signal needed here.
 * Without it a second tab kept the whole signed-in chrome and its last-rendered data: the
 * wallet still showed a balance and offered a Top up button, and every request it made went
 * out with no token and came back refused — which the screens reported as "Check your
 * connection and press Refresh." The member was told something untrue about their money,
 * indefinitely, and only a manual reload put them back on /login.
 * </p>
 *
 * <p>
 * Only the token DISAPPEARING ends this tab's session. A `newValue` that is a different string
 * is the ordinary background rotation of an access token by whichever tab got there first, and
 * this tab keeps running on it — it reads storage on every request.
 * </p>
 */
function useCrossTabSessionEnd(statusRef: { current: AuthState["status"] }, endSession: () => void) {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // `key === null` is `localStorage.clear()` — the whole store went, token included.
      if (e.key !== null && e.key !== TOKEN_KEY) return;
      if (e.newValue !== null) return;
      // A tab still bootstrapping finds out for itself: its whoami goes out token-less and the
      // api client's session-ended handler catches the refusal.
      if (statusRef.current === "anonymous" || statusRef.current === "loading") return;
      endSession();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [statusRef, endSession]);
}

/**
 * An admin reset this member's password while their session was open.
 *
 * <p>
 * L-F4. The reset arms `PasswordChangeGate`, which then refuses that session everywhere but
 * the change-password route with `403 password_change_required`. This context only ever
 * learned the flag from `whoami` at boot, so an in-app route change afterwards rendered the
 * new screen against a stale context: a finder clicked Reports and got
 * `TOP-UPS — · SPENT — · REFUNDS (NET) — · TIME ON COURT —`, a stale "−40.00 cr" still in the
 * header, a Download wallet CSV button still offered, and no message of any kind — two 403s
 * swallowed into an empty state. Only a full page load re-read `whoami` and did the right
 * thing, which is what made it look like a page bug rather than a context one.
 * </p>
 *
 * <p>
 * Taking the refusal itself as evidence about the flag puts `RequireAuth` back in charge: it
 * routes to /change-password, where the screen says what happened and offers the one thing
 * that clears it. Its own hook for the same reason as {@link useCrossTabSessionEnd} — the
 * provider is against the complexity gate's length limit, and lizard only counts a line as
 * gone when it moves to another function.
 * </p>
 */
function usePasswordChangeRequired(arm: () => void) {
  useEffect(() => {
    setPasswordChangeRequiredHandler(arm);
    return () => setPasswordChangeRequiredHandler(null);
  }, [arm]);
}

/**
 * Who this browser last had a CONFIRMED session for. (D3)
 *
 * <p>
 * The offline state means "there is a token and the club cannot be reached to say anything
 * about it", and on its own that is not enough to render anything belonging to a person: a
 * token is a string in `localStorage` that nothing has vouched for. This is the second fact —
 * the id of the member `whoami` last actually confirmed, on this device. Together they are what
 * {@link OFFLINE_CAPABLE} routes are allowed to render a last-known store against.
 * </p>
 *
 * <p>
 * It is written only where the server has answered, and cleared wherever a session ends, so it
 * can never be true of somebody who has signed out. It is NOT a credential and grants nothing:
 * every request still carries the token and the API still decides.
 * </p>
 */
const LAST_IDENTITY_KEY = "crusaders.mainframe.last-identity";

/** Never throws — private mode refuses writes and a locked-down profile refuses reads. */
export function readLastIdentity(): string | null {
  try { return window.localStorage?.getItem(LAST_IDENTITY_KEY) ?? null; } catch { return null; }
}

/**
 * Records the confirmed member — and drops the last-known store when it is somebody else.
 *
 * <p>
 * <b>The second half is the privacy rule, and it is not the same as the one on sign-out.</b>
 * Signing out clears the store, but a session does not always end that way: a phone kills the
 * tab, a member walks off, the token expires unseen. The next member signs in on the same
 * device and the previous one's code, court and door times are still in `localStorage` — and
 * before D3 that was harmless only because nothing ever rendered them. It is not harmless now.
 * So a confirmed id that differs from the stored one forgets everything the last one left.
 * </p>
 */
function rememberIdentity(userId: string): void {
  if (readLastIdentity() !== userId) forgetLastKnown();
  try { window.localStorage?.setItem(LAST_IDENTITY_KEY, userId); } catch { /* private mode */ }
}

/**
 * A session is over: the id goes, and everything the page stored under it goes with it.
 *
 * <p>
 * Called from BOTH endings, and the second matters more than the first. `logout` is a member
 * pressing something; `endSession` is a token expiring, being revoked, or an admin resetting a
 * password — which on a shared club phone is how a session usually ends, with nobody pressing
 * anything at all.
 * </p>
 *
 * <p>
 * It is the other half of `clearOfflineCache()`, not a duplicate of it. That purges the Cache
 * API; the member code page's last-known store is `localStorage`, which no cache purge touches,
 * and until D3 nothing ever cleared it because nothing ever rendered it while signed out.
 * </p>
 */
function forgetIdentity(): void {
  try { window.localStorage?.removeItem(LAST_IDENTITY_KEY); } catch { /* nothing to do */ }
  forgetLastKnown();
  // R3-3 — and the club goes too. The remembered zone is the CLUB's, not the member's, and a
  // club-desk tablet is one browser profile shared by whoever holds it; a second club's admin
  // signing in on it must not read the first club's midnight until their own payload lands.
  forgetClubZone();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [sessionExpired, setSessionExpired] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const probeTimer = useRef<number | null>(null);
  // The current status, readable from callbacks that were registered once — the api client's
  // session-expired handler and the cross-tab `storage` listener. Both are called by the
  // browser at a moment of its choosing, so they need what the state is NOW, not what it was
  // when they were wired up.
  const statusRef = useRef<AuthState["status"]>("loading");
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
    forgetIdentity(); // D3 — see its own comment; this is the ending nobody presses anything for.
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
        // D3 — the only place a confirmed identity is written, because this is the only place
        // the club has said who the token belongs to.
        rememberIdentity(w.user_id);
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

  useEffect(() => { statusRef.current = state.status; }, [state.status]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- session bootstrap on mount; no-token path resolves to anonymous synchronously
  useEffect(() => { refreshFromToken(); }, [refreshFromToken]);

  useEffect(() => () => { if (probeTimer.current) window.clearTimeout(probeTimer.current); }, []);

  // Centralised session-expired handler — wired to the api client so a refusal on an
  // authenticated request flips the app back to anonymous and lets RequireAuth route the user
  // to /login.
  //
  // Guarded on the CURRENT status, through a ref rather than a dependency, because the handler
  // is registered once and called from a fetch that may land at any time. A screen that is
  // already anonymous — /login itself, /register — must not be told its session ended; without
  // the guard, one refusal on an anonymous screen would put "Your session ended, so we've
  // signed you out." above a sign-in form nobody had signed into.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (statusRef.current === "anonymous") return;
      // Same reasoning as endSession: the session is over, so nothing this browser cached
      // while it was alive may survive it.
      void clearOfflineCache();
      setSessionExpired(true);
      setState({ status: "anonymous" });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const armPasswordChange = useCallback(() => {
    setState((s) => (s.status === "authenticated" && !s.mustChangePassword
      ? { ...s, mustChangePassword: true }
      : s));
  }, []);
  usePasswordChangeRequired(armPasswordChange);

  useCrossTabSessionEnd(statusRef, endSession);

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
    // browser stored while the last session was alive. Two stores, two calls.
    void clearOfflineCache();
    forgetIdentity();
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
