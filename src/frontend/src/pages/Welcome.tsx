import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";

export default function WelcomePage() {
  const { token } = useParams<{ token: string }>();
  const auth = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState<string | null>(token ? null : "Missing token.");

  useEffect(() => {
    if (!token) return;
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
