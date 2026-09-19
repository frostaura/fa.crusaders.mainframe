import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError, endpoints, errorCode } from "../lib/api";
import { isPasskeySupported } from "../lib/webauthn";
import { AuthShell } from "../components/AuthShell";
import { Button, Input, Label } from "../components/Button";

// Seeded by Seeder.cs in Development. Hidden behind import.meta.env.DEV so it disappears in prod builds.
const DEV_ADMIN_EMAIL = "any@frostaura.net";
const DEV_ADMIN_PASSWORD = "ChangeMeOnFirstLogin!";

/** Where a signed-in member goes when they did not ask for anywhere in particular. */
const DEFAULT_LANDING = "/schedule";

/**
 * A refused sign-in, told apart by the membership status the API sends with it.
 *
 * <p>
 * All three used to share one sentence — "Your account isn't approved yet. An admin will email
 * you once they've reviewed it." — and for two of the three both halves of it were false. A
 * suspended member HAD been approved and had already been emailed the reason; a rejected
 * applicant had already been reviewed, and the review was a refusal. Neither was waiting for
 * anything, so the one instruction the screen gave them was to wait.
 * </p>
 *
 * <p>
 * `status` is on the refusal body (`{"error":"not_approved","status":"Suspended"}`) and the
 * screen simply threw it away. Each sentence now names what happened and who can undo it;
 * only the genuinely pending case is asked to wait.
 * </p>
 */
function describeNotApproved(status: string | number | null): string {
  if (status === "Suspended") {
    return "Your membership is suspended, so you can't sign in. The club emailed you the reason — speak to them to have it restored.";
  }
  if (status === "Rejected") {
    return "Your application wasn't approved, so this account can't be used. The club emailed you the reason — contact them if you think it's a mistake.";
  }
  return "Your account isn't approved yet. An admin will email you once they've reviewed it.";
}

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
    if (err.status === 403) return describeNotApproved(err.detail("status"));
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
    // `my-auto` centres the card inside Layout's headerless flex column. Sign-in is short
    // enough to centre; register is not — see the note in that file.
    <AuthShell className="my-auto" subline="Court bookings, credits and your club account.">
      <>
        <h1 className="text-lg font-semibold mb-4">Sign in</h1>
        {auth.sessionExpired && !error && (
          <p role="status" className="text-sm text-warning-strong bg-warning-soft border border-warning-soft rounded-lg px-3 py-2 mb-4">
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
          {/*
            role="alert", and a left rule rather than a bare red sentence. A refusal that looks
            like body copy is one a member skims past and then presses the button again.
          */}
          {error && (
            <p role="alert" className="rounded-lg border-l-4 border-danger-strong bg-danger-soft px-3 py-2.5 text-sm text-danger-strong">
              {error}
            </p>
          )}
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
          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <div className="mt-4 flex justify-between text-sm">
          <Link to="/register" className="text-accent-strong hover:underline">Register</Link>
          {/*
            Reads as a link at rest, not on hover. It was body-slate with no underline — the
            caption colour — sitting beside an accent-blue "Register", so the one control that
            helps a member who cannot get in was the one that did not look clickable.
          */}
          <Link to="/forgot-password" className="text-accent-strong underline underline-offset-2 hover:no-underline">Forgot password?</Link>
        </div>

        {isPasskeySupported() && (
          <>
            {/*
              A labelled full-width button, not a bare circular icon with a caption under it.
              The circle was a 56px target with its name rendered as separate 11px grey text —
              it read as decoration, and the fastest way to sign in was the thing that looked
              least like a control.
            */}
            <div className="relative my-5">
              <hr className="border-border" />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg-surface px-2 text-xs text-text-muted">
                or
              </span>
            </div>
            <Button type="button" variant="outline" onClick={passkeyLogin} disabled={loading} className="w-full">
              <Fingerprint size={18} aria-hidden="true" />
              Sign in with a passkey
            </Button>
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
      </>
    </AuthShell>
  );
}
