import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { readLastIdentity, useAuth } from "../../lib/auth";
import { BootSplash, ConnectionLost } from "./SessionScreens";
import { LANDING_PATH } from "./nav";

/**
 * The routes that are worth anything with no signal at all. (D3)
 *
 * <p>
 * One, today, and the list is deliberately a literal rather than a prop somebody can pass: a
 * route that renders while the club cannot be reached is rendering from a store on the device,
 * and which screens may do that is an app-wide decision, not a per-page one.
 * </p>
 *
 * <p>
 * <b>Why `/my-code` earns it.</b> Reviewer D's finding is a member standing at a locked door
 * with no signal, which is not an edge case — it is the moment the whole surface was designed
 * for. `lib/lastKnown` exists because the service worker is forbidden to cache a byte of member
 * data, so the page keeps its own copy of the last code, the club's door rules and the club's
 * telephone number. All of it was unreachable behind `ConnectionLost`: the app-wide gate fired
 * before the page that knew how to cope. Every other route needs the club to say anything true,
 * and gets the honest "can't reach it" screen.
 * </p>
 */
const OFFLINE_CAPABLE = new Set(["/my-code"]);

/**
 * The guard on every member and admin route.
 *
 * <p>
 * It carries the location it turned away in router state, so `/login` can finish the journey the
 * member actually started. Without that, a "top up" link from an email or a bookmarked
 * `/wallet` was silently discarded and every sign-in landed on the default screen — the member
 * had to navigate to the thing they had already asked for.
 * </p>
 *
 * <p>
 * It also holds a session whose password an admin has just reset on `/change-password`. That is
 * courtesy, not security: `PasswordChangeGate` on the API refuses the same session everywhere
 * else regardless, because a redirect is only ever a suggestion to whatever holds the token.
 * </p>
 *
 * <p>
 * Exported for `offline-routing.test.tsx`, which is the only test that can hold the
 * offline-capable rule: the decision is three conditions deep and the two that matter most —
 * "only these routes" and "only a confirmed identity" — are invisible to the production-build
 * e2e, which necessarily arrives with both already satisfied.
 * </p>
 */
export function RequireAuth(props: { children: ReactNode; admin?: boolean; allowAnonymous?: boolean }) {
  const { children, admin = false, allowAnonymous = false } = props;
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading") return <BootSplash />;
  // A session we cannot confirm is not a session we have lost. Bouncing to /login here is what
  // turned a few seconds of backend downtime into a permanent sign-out for everyone on the site.
  //
  /**
   * D3 — and an offline-capable route falls through instead.
   *
   * <p>
   * Three conditions, and each is load-bearing. The state must be `offline`, which `auth.tsx`
   * reaches only on a network failure and never on a 401 — an authentication refusal still ends
   * the session and still goes to `/login`, because "the club says this token is bad" and "I
   * could not ask" are different events and conflating them is the older bug this file already
   * carries a paragraph about. The route must be on the list above. And this device must hold
   * an identity the club has actually confirmed at some point: a token alone is a string in
   * `localStorage` that nothing has vouched for, and a first-ever visitor who is handed one has
   * no last-known store to render anyway.
   * </p>
   *
   * <p>
   * The page is still responsible for saying that what it is showing is remembered rather than
   * fresh. It knows how — every sentence on it is built from a store that records an absolute
   * expiry and its own age — and it could not say it while it was not being rendered.
   * </p>
   */
  if (auth.status === "offline") {
    if (!copesWithoutClub(location.pathname)) return <ConnectionLost onRetry={auth.retryConnection} cause={auth.cause} />;
    return <>{children}</>;
  }
  if (auth.status !== "authenticated") {
    if (rendersSignedOut(location.pathname, allowAnonymous)) return <>{children}</>;
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  if (auth.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  // A member who follows an admin link lands on their own landing, not on a redirect to it.
  if (admin && !auth.isAdmin) return <Navigate to={LANDING_PATH} replace />;
  return <>{children}</>;
}

/** D3 — an offline-capable route, on a device that has confirmed a member at some point. */
function copesWithoutClub(pathname: string): boolean {
  return OFFLINE_CAPABLE.has(pathname) && readLastIdentity() !== null;
}

/**
 * Signed out, what may still render. R1 (lane F2): a page that knows how to be signed out (an
 * invite link's preview). F4.1: a session that LAPSED leaves the member's identity and code key on
 * this phone (only a sign-out wipes them), so /my-code goes on showing the code, signed out, with a
 * way back in. A device that never confirmed anybody, or whose member signed out, gets /login.
 */
function rendersSignedOut(pathname: string, allowAnonymous: boolean): boolean {
  return allowAnonymous || copesWithoutClub(pathname);
}
