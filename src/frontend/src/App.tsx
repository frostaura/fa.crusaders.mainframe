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
            <Route path="*" element={<Navigate to="/" replace />} />
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
  if (auth.status === "loading") return <p className="p-4 text-text-secondary">Loading…</p>;
  if (auth.status !== "authenticated") return <Navigate to="/login" replace state={{ from: location }} />;
  if (auth.mustChangePassword && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  if (admin && !auth.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
