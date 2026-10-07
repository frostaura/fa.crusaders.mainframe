import { createContext, useContext } from "react";

/**
 * The session as the app reads it. `AuthProvider` (`auth.tsx`) owns and fills it; this module
 * has no load-time side effects, so a screen that only reads the session pulls in nothing else.
 */
export type AuthState =
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
  | {
      status: "offline";
      /**
       * V-10 — what the last probe failed with, so the screen can tell "busy" (a 429: the club
       * answered) from "unreachable". Absent when nothing was thrown worth naming.
       */
      cause?: unknown;
    }
  | {
      status: "authenticated"; userId: string; isAdmin: boolean;
      /**
       * The session is holding an admin-issued temporary password and can reach nothing but the
       * screen that replaces it. The API enforces this regardless (`PasswordChangeGate`); this
       * flag is only what lets the app route there instead of letting every screen fail with a
       * 403 the member cannot act on.
       */
      mustChangePassword: boolean;
      /** The session is an admin's demo-club member view (`whoami`): not an admin, and it draws the demo stripe. */
      demoMemberView?: boolean;
    };

/**
 * How the last session in this tab ended, until `/login` has read it. (D7, D11)
 *
 * <p>
 * <b>Held here, not in router state, because router state lost the race.</b> "Sign out
 * everywhere" used to hand its sentence to `/login` through `navigate(..., { state })`, and in
 * the real app the auth reset re-rendered the guarded page first: `RequireAuth` redirected to
 * `/login` carrying `{ from }` and the notice never arrived. A unit test with a bare `/profile`
 * route had no guard to race and stayed green. The provider outlives every route, so nothing can
 * overtake it.
 * </p>
 *
 * <p>
 * <b>It also decides whose "return to" a `from` is.</b> After a deliberate sign-out the next
 * person at the keyboard is not asked to land on the last person's page — they were landing on
 * `/profile` because the guard had captured it on the way out. After a session was taken away
 * (an expiry, a revocation) the page is kept, but only for the SAME member signing back in.
 * </p>
 */
export type SessionEnding = {
  kind: "signed-out" | "expired";
  /** Who the ended session belonged to, as far as this browser ever confirmed; null if never. */
  userId: string | null;
  /** What `/login` should say — "Sign out everywhere" passes its sentence here. */
  notice: string | null;
  /**
   * Where the NEXT person signing in should land, when the sign-out was asked for precisely so
   * somebody else could open that page — an invite sent to another account (D5). Anyone's.
   */
  returnTo?: string | null;
};

export type AuthCtx = AuthState & {
  /** Each sign-in resolves with the id of the member now signed in. */
  login: (email: string, password: string) => Promise<string>;
  loginWithPasskey: () => Promise<string>;
  loginAsSeededAdmin: () => Promise<string>;
  setSessionFromMagicLink: (token: string) => Promise<string>;
  /**
   * Resolves once the server has been told; the local session is gone before it resolves.
   * `returnTo` is for a sign-out asked for so that another member can open a page (D5).
   */
  logout: (options?: { returnTo?: string }) => Promise<void>;
  /**
   * After "Sign out everywhere": the server has already ended this session with every other, so
   * this is `logout`'s local half alone — the same stores wiped, the member code's key included,
   * and no server call, because the token it would send is already dead.
   */
  signedOutEverywhere: (notice?: string) => void;
  /** See {@link SessionEnding}. Null once `/login` has taken it, and after any sign-in. */
  sessionEnding: SessionEnding | null;
  clearSessionEnding: () => void;
  /** The forced change is done — clears the flag without a whole re-bootstrap. */
  /** After the member's own password change: adopt the fresh token (the one sent is now dead). */
  passwordChanged: (accessToken?: string) => void;
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

export const AuthContext = createContext<AuthCtx | null>(null);

/** The session, or null outside an `AuthProvider` (a hook rendered on its own in a test). */
export function useOptionalAuth() {
  return useContext(AuthContext);
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/**
 * Which demo-club stripe the app bar draws: an admin's (`admin` — the admin chrome the shell is
 * drawing, remembered offline too) or the member view's (`member` — a non-admin session the club
 * said is an admin's demo persona), or none.
 */
export function demoStripeFor(admin: boolean, auth: AuthState): "admin" | "member" | null {
  if (auth.status === "authenticated" && auth.demoMemberView) return "member";
  return admin ? "admin" : null;
}
