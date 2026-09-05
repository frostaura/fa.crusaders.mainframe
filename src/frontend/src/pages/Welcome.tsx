import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";

export default function WelcomePage() {
  const { token } = useParams<{ token: string }>();
  const auth = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(token ? null : "Missing token.");
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
      .catch(() => setError("This sign-in link has expired. Try signing in with your password instead."));
  }, [token, auth, nav]);

  return (
    <div className="max-w-md mx-auto pt-6">
      <Card>
        {error
          ? <p className="text-sm text-danger-strong">{error}</p>
          : <p>Signing you in…</p>}
      </Card>
    </div>
  );
}
