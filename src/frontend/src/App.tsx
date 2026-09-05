import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import { ToastProvider } from "./components/Toast";
import { BalanceProvider } from "./lib/balance";
import { ProfileProvider } from "./lib/profile";
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
import CourtCodePage from "./pages/CourtCode";
import ReportsPage from "./pages/Reports";
import { AdminDevicesPage } from "./pages/AdminDevices";
import NotFoundPage from "./pages/NotFound";
import { Card } from "./components/Card";
import { Button } from "./components/Button";
import { Loader2 } from "lucide-react";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ProfileProvider>
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
            <Route path="/court-code" element={<RequireAuth><CourtCodePage /></RequireAuth>} />
            <Route path="/reports" element={<RequireAuth><ReportsPage /></RequireAuth>} />
            <Route path="/admin/members" element={<RequireAuth admin><AdminMembersPage /></RequireAuth>} />
            <Route path="/admin/webhooks" element={<RequireAuth admin><AdminWebhooksPage /></RequireAuth>} />
            <Route path="/admin/biometric" element={<Navigate to="/admin/members" replace />} />
            <Route path="/admin/devices" element={<RequireAuth admin><AdminDevicesPage /></RequireAuth>} />
            <Route path="/admin/settings" element={<RequireAuth admin><AdminSettingsPage /></RequireAuth>} />
            <Route path="/admin/ledger" element={<RequireAuth admin><AdminLedgerPage /></RequireAuth>} />
            {/* A real 404, not a redirect. The catch-all used to send every unknown path to the
                marketing page, which is how a dead link in an email looked like a working one. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
        </ToastProvider>
        </BalanceProvider>
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
function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading") return <Booting />;
  // A session we cannot confirm is not a session we have lost. Bouncing to /login here is what
  // turned a few seconds of backend downtime into a permanent sign-out for everyone on the site.
  if (auth.status === "offline") return <ConnectionLost onRetry={auth.retryConnection} />;
  if (auth.status !== "authenticated") return <Navigate to="/login" replace state={{ from: location }} />;
  if (auth.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  if (admin && !auth.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Shown while a stored session exists and the club cannot be reached to confirm it.
 *
 * <p>
 * The member keeps their token throughout, so the moment the backend answers again the app
 * carries on where it was — no re-typed password, and nothing lost to a redeploy.
 * </p>
 */
function ConnectionLost({ onRetry }: { onRetry: () => Promise<void> }) {
  // The button had no pending state of any kind: pressed against a backend that accepts
  // the socket and never answers, it stayed `{ "Try again now", enabled, no aria-busy }`
  // for the full 25 seconds it took to give up. The member presses the only control the
  // outage screen offers and, as far as the screen is concerned, nothing happens — so
  // they press it again, and again. A retry is worth nothing if it is not visibly a retry.
  const [retrying, setRetrying] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const retry = async () => {
    setRetrying(true);
    try { await onRetry(); } finally { if (alive.current) setRetrying(false); }
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
          <Button onClick={() => { void retry(); }} disabled={retrying} aria-busy={retrying}>
            {retrying && <Loader2 size={16} className="animate-spin motion-reduce:animate-none mr-2" aria-hidden="true" />}
            {retrying ? "Trying…" : "Try again now"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/**
 * The screen between opening the app and knowing whether there is a session.
 *
 * <p>
 * It was the literal word "Loading…" at 14px in the top-left corner, and against a backend
 * that accepts the connection and never answers it stayed exactly that for the whole 20s
 * request budget: no spinner, no skeleton, nothing clickable, no explanation. Twenty
 * seconds of a single static word reads as a broken app, and the outage screen that comes
 * after it is fine — it is the silence in front of it that costs the trust.
 * </p>
 *
 * <p>
 * `role="status"` so a screen reader is told at all, and a second sentence once the wait
 * has stopped being ordinary. The spinner is what says the app is still trying; it is
 * dropped under `prefers-reduced-motion` and the words carry the meaning on their own.
 * </p>
 */
function Booting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 4_000);
    return () => window.clearTimeout(t);
  }, []);

  return (
    <div role="status" aria-live="polite" className="max-w-md mx-auto px-4 py-16 flex flex-col items-center gap-3 text-center">
      <Loader2 size={28} className="animate-spin motion-reduce:animate-none text-text-muted" aria-hidden="true" />
      <p className="text-text-secondary">
        {slow ? "Still connecting to the club — this is taking longer than usual." : "Connecting to the club…"}
      </p>
    </div>
  );
}
