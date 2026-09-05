import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError, endpoints, errorCode } from "../lib/api";
import { isPasskeySupported } from "../lib/webauthn";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

// Seeded by Seeder.cs in Development. Hidden behind import.meta.env.DEV so it disappears in prod builds.
const DEV_ADMIN_EMAIL = "any@frostaura.net";
const DEV_ADMIN_PASSWORD = "ChangeMeOnFirstLogin!";

/** Where a signed-in member goes when they did not ask for anywhere in particular. */
const DEFAULT_LANDING = "/schedule";

export default function LoginPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set only for `email_not_verified`, which is the one sign-in refusal the member can repair
  // from this screen. It offers the resend, and then reports what the resend did.
  const [offerResend, setOfferResend] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");

  /**
   * The page the member actually asked for, captured by `RequireAuth` when it turned them away.
   * Only ever an in-app path: a `from` carrying an absolute URL would make this an open redirect.
   */
  const from = (() => {
    const state = location.state as { from?: { pathname?: string; search?: string } } | null;
    const path = state?.from?.pathname;
    if (!path || !path.startsWith("/") || path.startsWith("//")) return DEFAULT_LANDING;
    if (path === "/login") return DEFAULT_LANDING;
    return `${path}${state?.from?.search ?? ""}`;
  })();

  const land = () => {
    auth.clearSessionExpired();
    nav(from, { replace: true });
  };

  const describeFailure = (err: unknown) => {
    if (!(err instanceof ApiError)) return "Couldn't reach the club. Check your connection and try again.";
    const code = errorCode(err);
    if (err.status === 401) return "Email or password is incorrect.";
    if (err.status === 429) return "Too many sign-in attempts. Wait a minute, then try again.";
    if (err.status === 403 && code === "email_not_verified") {
      // Was a bare 403 mapped to "Your account isn't approved yet." — which told approved members
      // the wrong thing about the wrong thing, and left them nothing to do.
      return "You haven't confirmed your email address yet. Check your inbox for the link we sent when you registered.";
    }
    if (err.status === 403) return "Your account isn't approved yet. An admin will email you once they've reviewed it.";
    return "Sign in failed. Try again in a moment.";
  };

  const doLogin = async (e: string, p: string) => {
    setError(null);
    setOfferResend(false);
    setResendState("idle");
    setLoading(true);
    try {
      await auth.login(e, p);
      land();
    } catch (err) {
      setError(describeFailure(err));
      setOfferResend(err instanceof ApiError && err.status === 403 && errorCode(err) === "email_not_verified");
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    setResendState("sending");
    try { await endpoints.resendVerification(email.trim()); } catch { /* see below */ }
    // Reported as sent either way, deliberately: the endpoint answers the same for an address it
    // has never seen, and a screen that distinguished them would put the enumeration oracle back.
    setResendState("sent");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await doLogin(email, password);
  };

  const devAdminLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await auth.loginAsSeededAdmin();
      land();
    } catch {
      // Fall back to plain credential login if the dev endpoint is disabled (e.g. non-Dev build).
      await doLogin(DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD);
    } finally {
      setLoading(false);
    }
  };

  const passkeyLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      await auth.loginWithPasskey();
      land();
    } catch (err) {
      if (err instanceof Error && err.message === "passkey_cancelled") return; // user dismissed
      if (err instanceof ApiError && err.status === 401) setError("That passkey isn't recognised. Sign in with email and password, then add a passkey from settings.");
      else setError("Passkey sign-in failed. Try email and password.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <h1 className="text-xl font-semibold mb-1">Sign in</h1>
        <p className="text-sm text-text-secondary mb-5">Crusaders Squash</p>
        {auth.sessionExpired && !error && (
          <p className="text-sm text-warning-strong bg-warning-soft border border-warning-soft rounded-lg px-3 py-2 mb-4">
            Your session ended, so we've signed you out. Sign in again to pick up where you left off.
          </p>
        )}
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
          {error && <p className="text-sm text-danger-strong">{error}</p>}
          {offerResend && (
            resendState === "sent" ? (
              <p className="text-sm text-text-secondary">
                Sent. If that address is registered and still unconfirmed, a fresh link is on its way — it replaces any earlier one.
              </p>
            ) : (
              <Button
                type="button" variant="outline" className="w-full"
                onClick={resendVerification}
                disabled={resendState === "sending" || !email.trim()}
              >
                {resendState === "sending" ? "Sending…" : "Resend the confirmation email"}
              </Button>
            )
          )}
          <Button type="submit" disabled={loading} className="w-full">{loading ? "Signing in…" : "Sign in"}</Button>
        </form>
        <div className="mt-4 flex justify-between text-sm">
          <Link to="/register" className="text-accent-strong hover:underline">Register</Link>
          <Link to="/forgot-password" className="text-text-secondary hover:underline">Forgot password?</Link>
        </div>

        {isPasskeySupported() && (
          <>
            <hr className="my-6 border-border" />
            <button
              type="button"
              onClick={passkeyLogin}
              disabled={loading}
              aria-label="Sign in with passkey"
              title="Sign in with passkey"
              className="mx-auto flex items-center justify-center w-14 h-14 rounded-full bg-info-soft text-info-strong hover:bg-info-soft/70 disabled:opacity-50 transition"
            >
              <Fingerprint size={28} />
            </button>
            <p className="text-center text-xs text-text-muted mt-2">Sign in with passkey</p>
          </>
        )}

        {(import.meta.env.DEV || import.meta.env.VITE_SHOW_DEV_LOGIN === "true") && (
          <div className="mt-6 pt-4 border-t border-border">
            <p className="text-xs text-text-muted mb-2">Dev shortcuts</p>
            <Button variant="outline" type="button" onClick={devAdminLogin} disabled={loading} className="w-full">
              Sign in as seeded admin
            </Button>
            <p className="text-[11px] text-text-muted mt-2 font-mono">
              {DEV_ADMIN_EMAIL} · {DEV_ADMIN_PASSWORD}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
