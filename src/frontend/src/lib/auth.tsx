import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, endpoints, endSessionGeneration, refreshIsOwed, refreshSession, sessionGeneration, setPasswordChangeRequiredHandler, setUnauthorizedHandler, TOKEN_KEY, tokenStore, type WhoAmI } from "./api";
import { loginWithPasskey as runPasskeyLogin } from "./webauthn";
import { clearOfflineCache } from "./pwa";
import { forgetLastKnown } from "./lastKnown";
import { wipeMemberCode } from "./memberCode/keyStore";
import { setDataOwner, setPersistGuard, wipeMemberData } from "./offline/queryCache";
import { AuthContext, type AuthCtx, type AuthState, type SessionEnding } from "./useAuth";
import { sessionCheckSent } from "./sessionCheck";
import { readLastIdentity, writeLastIdentity } from "./lastIdentity";
import { wipeSessionData } from "./sessionWipe";

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

/**
 * The bootstrap probe, given one refresh (F4.1). `whoami` is exempt from the api client's refresh
 * (an anonymous probe is allowed its 401), so a phone opened after the access token lapsed would
 * otherwise go straight to /login with a perfectly good refresh cookie in the jar. One exchange,
 * one more probe; a second refusal is the answer.
 *
 * <p>
 * C2 — an exchange the club did not answer (5xx, 429, timeout, no network) throws ITS error, which
 * is not an auth refusal, so the provider goes to the outage state and keeps the token. Before
 * this, a redeploy's 503 on the refresh call signed a member out as surely as a revoked session.
 * </p>
 */
async function whoamiRefreshingOnce(token: string): Promise<WhoAmI> {
  let first: WhoAmI | null = null;
  try {
    first = await endpoints.whoami();
    if (first.is_authenticated) return first;
  } catch (err) {
    if (!isAuthRefusal(err)) throw err;
  }
  const outcome = await refreshSession(token);
  if (outcome.kind === "transient") throw outcome.error;
  if (outcome.kind === "ended") {
    if (first) return first;
    throw new ApiError(401, { error: "session_ended" });
  }
  return endpoints.whoami();
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
      // C1 — before anything else, and whatever this tab's status: an exchange in flight here
      // must not store its reply over another tab's sign-out.
      endSessionGeneration(false);
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
  if (readLastIdentity() !== userId) {
    forgetLastKnown();
    // D1 — and the last member's code key. `loadFor` refuses a key stored for somebody else
    // anyway; wiping it here as well means it does not sit on a shared phone until My Code opens.
    void wipeMemberCode();
    // R4 wave B — and every read kept on the phone for the last member (`lib/offline`).
    void wipeMemberData();
  }
  writeLastIdentity(userId);
  setDataOwner(userId);
}

/**
 * R4 wave B — whose reads `lib/offline` may keep and show: the member this phone last CONFIRMED,
 * and only while a token is held (the two conditions an offline-capable route renders on). A
 * write to the phone is allowed only while both still name that member — read at the moment of
 * writing, from storage another tab's sign-out clears, so a read landing after a sign-out in any
 * tab is never kept.
 */
setPersistGuard((who) => tokenStore.get() !== null && readLastIdentity() === who);
setDataOwner(tokenStore.get() ? readLastIdentity() : null);

/**
 * The local half of every ending — `logout`, `signedOutEverywhere` and an expiry alike — so the
 * three can never wipe different things. A club phone is a shared device; the next person to
 * sign in must inherit nothing this browser stored while the last session was alive: the token,
 * the offline caches, and (through `forgetIdentity`) the member code's key.
 */
function endLocally(): void {
  // C1 — first, so an exchange whose reply lands after this line is discarded, in every tab.
  endSessionGeneration(true);
  tokenStore.clear();
  // Every cache but the offline shell (M5-1), the member's reads kept on the phone (R4 wave B), and
  // through `sessionWipe`'s `forgetIdentity` the code's key: sign-out leaves nothing of them, in memory or stored.
  void wipeSessionData();
}

/**
 * The local half of a session TAKEN AWAY — an expiry the refresh cookie could not rescue, a
 * revocation — as opposed to one given up (F4.1, the P7 decision).
 *
 * <p>
 * <b>Only an explicit sign-out wipes the member code's key.</b> A member whose session lapses is
 * still that member, standing at a door; the key on the phone still makes their code, and wiping
 * it turned "signed out after a while" into "locked out until you find signal and sign in". So
 * this drops the token and the risky caches (never the offline shell — M5-1) and KEEPS the confirmed identity, the key, the
 * last-known door facts and the club's zone — which is what lets `/my-code` go on showing the
 * code signed out. A different member signing in on this phone still wipes all of it
 * (`rememberIdentity`), and the sign-out buttons still call {@link endLocally}.
 * </p>
 */
function endTakenAway(): void {
  endSessionGeneration(false);
  tokenStore.clear();
  // M5-1 (review round 5) — every cache BUT the shell and the build: a lapsed member's code is
  // drawn from the key kept above, and that needs the app to open with no signal at the door.
  void clearOfflineCache();
  // R4 wave B — the member's kept reads go with the offline caches. Unlike the code's key they
  // open no door, and a phone left signed out must not keep showing a wallet to whoever holds it.
  void wipeMemberData();
}

/**
 * While authenticated, refresh the access token a minute before it expires, so an active session
 * never breaks under the member — and, after a transient failure (C2), try again when the tab
 * comes back into view rather than waiting for a request to be refused.
 *
 * <p>
 * C1 — a reply that lands after a sign-out (here or in another tab) is discarded, never stored:
 * the generation is read before the call and compared when it answers. Only a 401 from the
 * refresh ends the session (the api client's handler does that); anything else is retried later.
 * Its own hook for the provider's length gate.
 * </p>
 */
function useProactiveRefresh(status: AuthState["status"]) {
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    let timer: number | null = null;
    const schedule = (delay: number) => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void run(); }, delay);
    };
    const run = async () => {
      if (cancelled) return;
      const generation = sessionGeneration();
      try {
        const r = await endpoints.refresh();
        if (cancelled || generation !== sessionGeneration() || !tokenStore.get()) return;
        tokenStore.set(r.access_token);
        schedule(nextRefreshDelayMs(r.access_token));
      } catch {
        // A 401 has already ended the session through the api client's handler. Anything else is
        // the club not answering: keep the token and try again in a while.
        if (!cancelled) schedule(RETRY_REFRESH_MS);
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !refreshIsOwed()) return;
      const token = tokenStore.get();
      if (token) void refreshSession(token, { now: true });
    };
    const t = tokenStore.get();
    if (t) schedule(nextRefreshDelayMs(t));
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [status]);
}

/** After a proactive refresh the club did not answer: try again in 30 s. */
const RETRY_REFRESH_MS = 30_000;

type LoginAnswer = { access_token: string; user_id: string; is_admin: boolean; must_change_password?: boolean };

/**
 * The four ways in, which all end the same way: store the token, forget how the last session
 * ended, and become that member. Each resolves with the member's id so `/login` can decide
 * whether a remembered "return to" page is theirs (D11). Out of the provider for the length gate.
 */
function useSignIns(
  setState: (next: AuthState) => void,
  setSessionExpired: (expired: boolean) => void,
  setSessionEnding: (ending: SessionEnding | null) => void,
) {
  const adopt = useCallback((r: LoginAnswer) => {
    tokenStore.set(r.access_token);
    // The club has just said who this is — as surely as `whoami` does. Recorded here too (R1, F3
    // follow-up): only the boot probe used to, so after a form sign-in the device still named
    // whoever it last confirmed; a lapse was then filed as THAT member's, and the admin signing
    // back in was refused their own page as "somebody else's" and sent to the landing.
    rememberIdentity(r.user_id);
    setSessionExpired(false);
    setSessionEnding(null);
    setState({ status: "authenticated", userId: r.user_id, isAdmin: r.is_admin, mustChangePassword: r.must_change_password === true });
    return r.user_id;
  }, [setState, setSessionExpired, setSessionEnding]);
  return useMemo(() => ({
    login: async (email: string, password: string) => adopt(await endpoints.login(email, password)),
    loginWithPasskey: async () => adopt(await runPasskeyLogin()),
    loginAsSeededAdmin: async () => adopt(await endpoints.devAdminLogin()),
    setSessionFromMagicLink: async (token: string) => adopt(await endpoints.magicLink(token)),
  }), [adopt]);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionEnding, setSessionEnding] = useState<SessionEnding | null>(null);
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
    setSessionEnding({ kind: "expired", userId: readLastIdentity(), notice: null });
    endTakenAway(); // F4.1 — the key stays; see endTakenAway.
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
      const probe = whoamiRefreshingOnce(t);
      // Sent: now whatever waited for the session check to go FIRST may start (`main.tsx`).
      sessionCheckSent();
      const w = await probe;
      if (w.is_authenticated && w.user_id) {
        probeAttempt.current = 0;
        // D3 — the only place a confirmed identity is written, because this is the only place
        // the club has said who the token belongs to.
        rememberIdentity(w.user_id);
        setState({ status: "authenticated", userId: w.user_id, isAdmin: w.is_admin, mustChangePassword: w.must_change_password === true, demoMemberView: w.demo_member_view === true });
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
      setState({ status: "offline", cause: err });
      const delay = nextProbeDelayMs(probeAttempt.current);
      probeAttempt.current += 1;
      if (probeTimer.current) window.clearTimeout(probeTimer.current);
      probeTimer.current = window.setTimeout(() => { probeAgain.current(); }, delay);
    }
  }, [endSession]);

  useEffect(() => { probeAgain.current = refreshFromToken; }, [refreshFromToken]);

  // Layout, not passive: the ref must hold the new status by the time anything can observe the
  // render — a sign-out in another tab landing between the paint and a passive effect was
  // ignored as "still loading".
  useLayoutEffect(() => { statusRef.current = state.status; }, [state.status]);

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
      setSessionEnding({ kind: "expired", userId: readLastIdentity(), notice: null });
      // Same as endSession: the refresh cookie could not rescue it (the api client tried once),
      // so the token and the offline caches go — and the member code's key stays (F4.1).
      endTakenAway();
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

  useProactiveRefresh(state.status);

  /** Ask the club again right now — what the "Try again" button on the outage screen does. */
  const retryConnection = useCallback(() => {
    if (probeTimer.current) { window.clearTimeout(probeTimer.current); probeTimer.current = null; }
    probeAttempt.current = 0;
    // Returned, not fire-and-forget. See the type above.
    return refreshFromToken();
  }, [refreshFromToken]);

  // R4 wave B — the phone found a network again: ask the club now rather than at the end of the
  // backoff, so the pages drawn from the phone's copy refresh the moment they can.
  useEffect(() => {
    const back = () => { if (statusRef.current === "offline") void retryConnection(); };
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, [retryConnection]);

  const { login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink } = useSignIns(setState, setSessionExpired, setSessionEnding);

  const endOnPurpose = useCallback((notice: string | null, returnTo: string | null) => {
    const userId = readLastIdentity();
    endLocally();
    // Signing out on purpose is not losing a session; /login should not commiserate about it.
    setSessionExpired(false);
    setSessionEnding({ kind: "signed-out", userId, notice, returnTo });
    setState({ status: "anonymous" });
  }, []);
  const signedOutEverywhere = useCallback((notice?: string) => endOnPurpose(notice ?? null, null), [endOnPurpose]);

  const logout = useCallback((options?: { returnTo?: string }) => {
    // Tell the server first, while the token is still in storage for the client to send: the
    // API puts that jti on its revocation list, so the credential stops working rather than
    // merely stopping being presented. A failure here is not worth blocking the sign-out —
    // the local half must happen either way — but it is worth attempting before the local half
    // rather than after, because after, there is nothing left to authenticate the call with.
    const ending = endpoints.logout().catch(() => undefined);
    endOnPurpose(null, options?.returnTo ?? null);
    return ending;
  }, [endOnPurpose]);

  // The refresh call answers with the flag too, so this is belt-and-braces — but a member who
  // has just replaced their password should not be held on the change screen by a stale flag
  // while a background refresh decides otherwise.
  const passwordChanged = useCallback((accessToken?: string) => {
    // The change ends every session minted before it, this one included, so the answer carries
    // this session's replacement token.
    if (accessToken) tokenStore.set(accessToken);
    setState((s) => (s.status === "authenticated" ? { ...s, mustChangePassword: false } : s));
  }, []);

  const clearSessionExpired = useCallback(() => setSessionExpired(false), []);
  const clearSessionEnding = useCallback(() => setSessionEnding(null), []);

  const value = useMemo<AuthCtx>(
    () => ({ ...state, login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink, logout, signedOutEverywhere, passwordChanged, sessionExpired, clearSessionExpired, sessionEnding, clearSessionEnding, retryConnection }),
    [state, login, loginWithPasskey, loginAsSeededAdmin, setSessionFromMagicLink, logout, signedOutEverywhere, passwordChanged, sessionExpired, clearSessionExpired, sessionEnding, clearSessionEnding, retryConnection],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

