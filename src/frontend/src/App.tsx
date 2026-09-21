import { Suspense, lazy, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, readLastIdentity, useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { BalanceProvider } from "./lib/balance";
import { ProfileProvider } from "./lib/profile";
import { ClubUiProvider } from "./lib/ClubUiProvider";
import HomePage from "./pages/Home";
import LoginPage from "./pages/Login";
import RegisterPage from "./pages/Register";
import VerifyEmailPage from "./pages/VerifyEmail";
import ForgotPasswordPage from "./pages/ForgotPassword";
import ResetPasswordPage from "./pages/ResetPassword";
import ChangePasswordPage from "./pages/ChangePassword";
import WelcomePage from "./pages/Welcome";
import WalletPage from "./pages/Wallet";
import SchedulePage from "./pages/Schedule";
import AdminMembersPage from "./pages/AdminMembers";
import TopUpPage from "./pages/TopUp";
import TopUpStatusPage from "./pages/TopUpStatus";
import AdminWebhooksPage from "./pages/AdminWebhooks";
import AdminSettingsPage from "./pages/AdminSettings";
import AdminLedgerPage from "./pages/AdminLedger";
import ProfilePage from "./pages/Profile";
import MyCodePage from "./pages/MyCode";
import ReportsPage from "./pages/Reports";
import { AdminDevicesPage } from "./pages/AdminDevices";
// doors: admin — the four doors routes and their pages, in one block.
import { AdminDoorsPage } from "./pages/AdminDoors";
import { AdminDoorsDetailPage } from "./pages/AdminDoorsDetail";
import { AdminDoorsLogPage } from "./pages/AdminDoorsLog";
import { AdminDoorsCardPage } from "./pages/AdminDoorsCard";
import NotFoundPage from "./pages/NotFound";
import { Card } from "./components/Card";
import { Button } from "./components/Button";
import { RouteAnnouncer } from "./components/RouteAnnouncer";

/**
 * The primitives preview — development only, and dropped from the production bundle.
 *
 * <p>
 * `import.meta.env.DEV` is replaced with a literal at build time, so the ternary folds to
 * `null`, the route below disappears, and the dynamic import is never reachable. It exists
 * because `SegmentedTabs` and the feedback theme have geometry that only a layout engine can
 * answer — a measured thumb, a control that flips to a vertical tablist when the labels stop
 * fitting, a 44 px target at a 32 px root font — and jsdom reports every offset as 0. The
 * Playwright suite runs `npm run dev`, which is where the route exists.
 * </p>
 */
const DevPrimitivesPage = import.meta.env.DEV ? lazy(() => import("./pages/DevPrimitives")) : null;

export default function App() {
  return (
    <BrowserRouter>
      {/*
        C6 — the three things a real page load does that a single-page app does not: name the
        document, move focus to where the new page begins, and say where you have arrived.
        Above `Routes` rather than inside `Layout`, because `Layout` returns early for the
        public landing and for every auth-flow screen, and those are routes too.
      */}
      <RouteAnnouncer />
      <AuthProvider>
        <ProfileProvider>
        {/* Inside ProfileProvider, because that is where the club's glyph choice arrives, and
            outside everything that draws one — so a sign-in button and a booking confirm wear
            the same marks. Absent or unrecognised, it is the default; never "the other one". */}
        <ClubUiProvider>
        <BalanceProvider>
        <ToastProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/verify-email/:token" element={<VerifyEmailPage />} />
            {/* Both halves of the self-service reset. The link on /login and the link in the
                reset email have always pointed here; neither route existed, so the catch-all
                below sent a locked-out member to the marketing page with no explanation. */}
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password/:token" element={<ResetPasswordPage />} />
            <Route path="/welcome/:token" element={<WelcomePage />} />
            <Route path="/wallet" element={<RequireAuth><WalletPage /></RequireAuth>} />
            <Route path="/wallet/topup" element={<RequireAuth><TopUpPage /></RequireAuth>} />
            <Route path="/wallet/topup/:topupId" element={<RequireAuth><TopUpStatusPage /></RequireAuth>} />
            <Route path="/schedule" element={<RequireAuth><SchedulePage /></RequireAuth>} />
            <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
            <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
            {/* doors: member — the code page becomes door-aware, and is renamed with it.
                `/court-code` is a PERMANENT redirect, not a deletion: it is in bookmarks,
                in the PWA manifest's shortcut, and in links already emailed to members.
                A dead link in an email is how a member ends up at the marketing page
                holding a phone at a locked door. */}
            <Route path="/my-code" element={<RequireAuth><MyCodePage /></RequireAuth>} />
            <Route path="/court-code" element={<Navigate to="/my-code" replace />} />
            {/* end doors: member */}
            <Route path="/reports" element={<RequireAuth><ReportsPage /></RequireAuth>} />
            <Route path="/admin/members" element={<RequireAuth admin><AdminMembersPage /></RequireAuth>} />
            <Route path="/admin/webhooks" element={<RequireAuth admin><AdminWebhooksPage /></RequireAuth>} />
            <Route path="/admin/biometric" element={<Navigate to="/admin/members" replace />} />
            <Route path="/admin/devices" element={<RequireAuth admin><AdminDevicesPage /></RequireAuth>} />
            {/* doors: admin. `/log` is declared BEFORE `/:id` or it resolves as a door id and
                the club log becomes a 404 nobody can explain. `/card` is a child of a door
                because it is that door's card, and its back link says so. */}
            <Route path="/admin/doors" element={<RequireAuth admin><AdminDoorsPage /></RequireAuth>} />
            <Route path="/admin/doors/log" element={<RequireAuth admin><AdminDoorsLogPage /></RequireAuth>} />
            <Route path="/admin/doors/:id" element={<RequireAuth admin><AdminDoorsDetailPage /></RequireAuth>} />
            <Route path="/admin/doors/:id/card" element={<RequireAuth admin><AdminDoorsCardPage /></RequireAuth>} />
            <Route path="/admin/settings" element={<RequireAuth admin><AdminSettingsPage /></RequireAuth>} />
            <Route path="/admin/ledger" element={<RequireAuth admin><AdminLedgerPage /></RequireAuth>} />
            {DevPrimitivesPage && (
              <Route
                path="/dev/primitives"
                element={<Suspense fallback={null}><DevPrimitivesPage /></Suspense>}
              />
            )}
            {/* A real 404, not a redirect. The catch-all used to send every unknown path to the
                marketing page, which is how a dead link in an email looked like a working one. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </ToastProvider>
        </BalanceProvider>
        </ClubUiProvider>
        </ProfileProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

/**
 * The guard on every member and admin route.
 *
 * <p>
 * It carries the location it turned away in router state, so `/login` can finish the journey the
 * member actually started. Without that, a "top up" link from an email or a bookmarked
 * `/wallet` was silently discarded and every sign-in landed on `/schedule` — the member had to
 * navigate to the thing they had already asked for.
 * </p>
 *
 * <p>
 * It also holds a session whose password an admin has just reset on `/change-password`. That is
 * courtesy, not security: `PasswordChangeGate` on the API refuses the same session everywhere
 * else regardless, because a redirect is only ever a suggestion to whatever holds the token.
 * </p>
 */
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
 * Exported for `offline-routing.test.tsx`, which is the only test that can hold the
 * offline-capable rule: the decision is three conditions deep and the two that matter most —
 * "only these routes" and "only a confirmed identity" — are invisible to the production-build
 * e2e, which necessarily arrives with both already satisfied.
 */
export function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
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
    const canCope = OFFLINE_CAPABLE.has(location.pathname) && readLastIdentity() !== null;
    if (!canCope) return <ConnectionLost onRetry={auth.retryConnection} />;
    return <>{children}</>;
  }
  if (auth.status !== "authenticated") return <Navigate to="/login" replace state={{ from: location }} />;
  if (auth.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  if (admin && !auth.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * The screen a member looks at while the app works out whether they are still signed in.
 *
 * <p>
 * It used to be the literal word "Loading…" at 14px in the top-left corner, and it stayed that
 * way for the full twenty seconds of the request budget against a backend that accepts the
 * connection and never answers. Measured on a live page: identical at 2s, 6s, 12s and 20.1s —
 * no spinner, no skeleton, no explanation, nothing to press. Twenty seconds of that reads as a
 * broken app, not as a slow one, and it is a member's first impression of the club's software.
 * </p>
 *
 * <p>
 * So: something moving from the first frame, and a sentence that grows a second line once the
 * wait stops being ordinary. The threshold is deliberately not a progress bar — nothing here
 * knows how long the backend will take, and a bar that fills at a made-up rate and then sits at
 * 95% is a worse lie than silence. The 20s ceiling itself is right and stays
 * (`REQUEST_TIMEOUT_MS`): it does not spin for ever, which is the important half.
 * </p>
 */
function BootSplash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 4000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div className="max-w-md mx-auto p-4" data-testid="boot-splash">
      <Card>
        {/* aria-live, because a screen-reader user gets nothing at all from a spinner. */}
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <Spinner />
          <p className="text-text-secondary">Connecting to the club…</p>
        </div>
        {slow && (
          <p className="mt-3 text-sm text-text-muted">
            This is taking longer than usual. We'll keep trying for a few more seconds.
          </p>
        )}
      </Card>
    </div>
  );
}

/** The one spinner in the product. `motion-reduce` so it holds still for anyone who asked it to. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block w-5 h-5 shrink-0 rounded-full border-2 border-border border-t-accent-strong animate-spin motion-reduce:animate-none"
    />
  );
}

/**
 * Shown while a stored session exists and the club cannot be reached to confirm it.
 *
 * <p>
 * The member keeps their token throughout, so the moment the backend answers again the app
 * carries on where it was — no re-typed password, and nothing lost to a redeploy.
 * </p>
 *
 * <p>
 * The button has a pending state because it is the only control this screen offers and, against
 * a stalled backend, it did nothing observable for 25 seconds: measured, one button state
 * throughout — not disabled, no `aria-busy`, no label change, no spinner. A member presses the
 * one thing they are given and the app says nothing, so they press it again, and again. The
 * retry now resolves when the probe does, which is what lets the label say so.
 * </p>
 */
function ConnectionLost({ onRetry }: { onRetry: () => void | Promise<void> }) {
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      // The probe resolving does not mean it succeeded — on failure this component stays mounted
      // and the button has to come back, or the member is left with a dead control.
      setRetrying(false);
    }
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <Card>
        <h1 className="text-xl font-semibold text-text-primary">Can't reach the club right now</h1>
        <p className="mt-2 text-text-secondary">
          You're still signed in. This is usually a brief interruption — we'll keep trying, and the
          page will carry on by itself once the connection is back.
        </p>
        <div className="mt-4">
          <Button onClick={retry} disabled={retrying} aria-busy={retrying}>
            {retrying ? <><Spinner />&nbsp;Trying…</> : "Try again now"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

