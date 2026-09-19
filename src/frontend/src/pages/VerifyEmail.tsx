import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { endpoints } from "../lib/api";
import { Card } from "../components/Card";

export default function VerifyEmailPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<"verifying" | "ok" | "fail">(token ? "verifying" : "fail");
  // Same single-use token, same rule as /welcome: spend it once. StrictMode invokes this effect
  // twice, so the second call was answered `400 invalid_or_expired` on a link that had just
  // been consumed successfully — and whichever settled last is what the member read.
  const spent = useRef<string | null>(null);

  useEffect(() => {
    if (!token) return;
    if (spent.current === token) return;
    spent.current = token;
    endpoints.verifyEmail(token).then((r) => setState(r.verified ? "ok" : "fail")).catch(() => setState("fail"));
  }, [token]);

  return (
    <div className="max-w-md mx-auto pt-6">
      <Card>
        {state === "verifying" && <p>Verifying your email…</p>}
        {state === "ok" && (
          <>
            <h1 className="text-xl font-semibold mb-2">Email verified</h1>
            <p className="text-sm text-text-secondary">An admin will review your application and get back to you by email.</p>
          </>
        )}
        {state === "fail" && (
          <>
            <h1 className="text-xl font-semibold mb-2">Link expired or already used</h1>
            <p className="text-sm text-text-secondary mb-4">Try registering again or contact the club admin.</p>
            <Link to="/register" className="text-accent-strong hover:underline text-sm">Re-register</Link>
          </>
        )}
      </Card>
    </div>
  );
}
