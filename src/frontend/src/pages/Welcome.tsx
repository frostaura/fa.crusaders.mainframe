import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { AUTH_SUBLINE, WELCOME } from "../lib/authCopy";
import { AuthMark, AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { TextLink } from "../components/ui/text-link";
import { LinkBreak } from "../components/ui/icons";
import { LANDING_PATH } from "../components/shell/nav";

export default function WelcomePage() {
  const { token } = useParams<{ token: string }>();
  const auth = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(token ? null : WELCOME.incomplete);
  /**
   * The magic link is single-use, so spending it is not something an effect may do twice.
   *
   * <p>
   * It was doing it four times: the effect depends on `auth`, a new object on every auth state
   * change including the one its own success causes, and StrictMode doubled each run — three
   * `400 invalid_or_expired` racing the one that worked, and whichever resolved last decided
   * whether the member landed in the club or read "expired" about a link that had just worked.
   * A ref, not state: it must be true for the very next run of the effect, not the next render.
   * </p>
   */
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (spent.current === token) return;
    spent.current = token;
    auth.setSessionFromMagicLink(token)
      .then(() => nav(LANDING_PATH, { replace: true }))
      // `POST /auth/magic-link/{token}` answers ONE code for a link that has expired and one
      // already used, so the sentence names both rather than picking the wrong one.
      .catch(() => setError(WELCOME.spent));
  }, [token, auth, nav]);

  // Already signed in on this device and the link is spent: the second click is almost always the
  // same person on the same phone, or a mail client that pre-fetched the link. Send them into the
  // club rather than showing them a refusal about a session they already have.
  if (error && auth.status === "authenticated") return <Navigate to={LANDING_PATH} replace />;

  if (error) return <LinkSpent message={error} title={token ? WELCOME.spentTitle : WELCOME.incompleteTitle} />;
  return (
    <AuthShell className="my-auto" subline={AUTH_SUBLINE.welcome}>
      <p role="status" className="flex items-center justify-center gap-3 py-6 text-base font-medium text-text-primary">
        <Spinner className="size-5 text-accent-strong" />
        {WELCOME.working}
      </p>
    </AuthShell>
  );
}

/**
 * N-F9 — the dead end at the end of a welcome email.
 *
 * <p>
 * A member who opened the welcome link a second time got one red sentence in an otherwise empty
 * card: no controls and no links at all, so the only way on was to know to edit the address bar.
 * Both ways on are navigation, so both are links (R10): signing in is the call to action, the
 * reset link the quieter second.
 * </p>
 */
function LinkSpent({ message, title }: { message: string; title: string }) {
  return (
    <AuthShell
      className="my-auto"
      subline={AUTH_SUBLINE.welcome}
      mark={<AuthMark icon={LinkBreak} tone="danger" />}
      title={title}
    >
      <div className="flex flex-col gap-4">
        <Alert>{message}</Alert>
        <p className="text-sm text-text-secondary">{WELCOME.reassure}</p>
        <Button asChild block><Link to="/login">{WELCOME.signIn}</Link></Button>
        <div className="flex justify-center">
          <TextLink to="/forgot-password" variant="standalone">{WELCOME.resetLink}</TextLink>
        </div>
      </div>
    </AuthShell>
  );
}
