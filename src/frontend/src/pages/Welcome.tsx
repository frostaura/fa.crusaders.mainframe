import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";
import { Button } from "../components/Button";

export default function WelcomePage() {
  const { token } = useParams<{ token: string }>();
  const auth = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(
    token ? null : "That sign-in link is incomplete — it may have been cut short on its way here.");
  /**
   * The magic link is single-use, so spending it is not something an effect may do twice.
   *
   * <p>
   * It was doing it four times. The effect depends on `auth`, which is a new object on every
   * auth state change — including the one its own success causes — so it re-ran after signing
   * the member in, and StrictMode doubled each run. Three of the four calls were therefore
   * `400 invalid_or_expired` racing the one that worked, and whichever resolved last decided
   * whether the member landed on /schedule or read "This sign-in link has expired." about a
   * link that had just worked.
   * </p>
   *
   * <p>
   * A ref, not a state flag: it must be true for the very next run of the effect, not after
   * the next render.
   * </p>
   */
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (spent.current === token) return;
    spent.current = token;
    auth.setSessionFromMagicLink(token)
      .then(() => nav("/schedule", { replace: true }))
      // `POST /auth/magic-link/{token}` answers ONE code, `invalid_or_expired`, for a link
      // that has expired and for one that has already been used — `ConsumeMagicLinkAsync`
      // filters on `UsedAt == null` and on the expiry in the same query and cannot tell the
      // caller which it was. So the sentence names both rather than picking the wrong one:
      // the finder's link had not expired, it had been used, and "expired" sends a member
      // to ask for a new one when what they need is the password they already have.
      .catch(() => setError("This sign-in link has expired or has already been used — welcome links work once."));
  }, [token, auth, nav]);

  // Already signed in on this device and the link is spent: the second click is almost always
  // the same person on the same phone, or a mail client that pre-fetched the link. Send them
  // into the club rather than showing them a refusal about a session they already have.
  if (error && auth.status === "authenticated") return <Navigate to="/schedule" replace />;

  return (
    <div className="max-w-md mx-auto pt-6">
      <Card>
        {error ? <LinkSpent message={error} /> : <p>Signing you in…</p>}
      </Card>
    </div>
  );
}

/**
 * N-F9 — the dead end at the end of a welcome email.
 *
 * <p>
 * A member who opened the welcome link a second time — on a second device, or because their
 * mail client pre-fetched it — got one red sentence in an otherwise empty card.
 * <code>getByRole('button')</code> returned <code>[]</code> and <code>locator('a')</code>
 * returned <code>[]</code>: no controls and no links at all, so the only way on was to know to
 * edit the address bar. The reset-password screen has always got this right — "Link expired?
 * Request a new one" — so the inconsistency was inside the product.
 * </p>
 */
function LinkSpent({ message }: { message: string }) {
  return (
    <>
      <h1 className="text-xl font-semibold mb-2">That link has already been used</h1>
      <p role="alert" className="text-sm text-danger-strong mb-3">{message}</p>
      <p className="text-sm text-text-secondary mb-4">
        Your account is fine — only the link is spent. Sign in with your password, or have the
        club email you a link to set one.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to="/login"><Button variant="outline">Sign in</Button></Link>
        <Link to="/forgot-password"><Button variant="ghost">Email me a reset link</Button></Link>
      </div>
    </>
  );
}
