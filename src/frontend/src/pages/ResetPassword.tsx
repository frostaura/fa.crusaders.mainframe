import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, endpoints, errorCode } from "../lib/api";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

/**
 * Self-service password reset, step two — the destination of the link in the email.
 *
 * <p>
 * `AuthService` has always built that link as `{PublicBaseUrl}/reset-password/{token}`, and until
 * now there was no such route: the reset mail landed on the marketing home page.
 * </p>
 */
export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    if (password.length < 8) { setError("Your new password must be at least 8 characters."); return; }
    if (!token) { setError("This reset link is incomplete. Request a new one."); return; }

    setLoading(true);
    try {
      await endpoints.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      // The API answers 400 for a token that is expired, already used or simply wrong — one
      // answer on purpose, because distinguishing them would tell a guesser which tokens exist.
      // The member's repair is the same in all three cases, so one sentence covers it.
      if (err instanceof ApiError && err.status === 400 && errorCode(err) === "password_too_short") {
        setError("Your new password must be at least 8 characters.");
      } else if (err instanceof ApiError && err.status === 400) {
        setError("This reset link has expired or has already been used. Request a new one.");
      } else if (err instanceof ApiError && err.status === 429) {
        setError("Too many attempts. Wait a minute, then try again.");
      } else {
        setError("Couldn't reset your password. Check your connection and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="max-w-md mx-auto pt-6">
        <Card>
          <h1 className="text-xl font-semibold mb-2">Password updated</h1>
          <p className="text-sm text-text-secondary mb-4">You can sign in with your new password now.</p>
          <Button onClick={() => nav("/login")} className="w-full">Sign in</Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto pt-6">
      <Card>
        <h1 className="text-xl font-semibold mb-1">Choose a new password</h1>
        <p className="text-sm text-text-secondary mb-5">This link works once, and only for an hour after it was sent.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="password">New password</Label>
            <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <p className="text-xs text-text-muted mt-1">At least 8 characters.</p>
          </div>
          <div>
            <Label htmlFor="confirm">Confirm new password</Label>
            <Input id="confirm" type="password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </div>
          {error && <p className="text-sm text-danger-strong">{error}</p>}
          <Button type="submit" disabled={loading} className="w-full">{loading ? "Saving…" : "Set new password"}</Button>
        </form>
        <p className="mt-4 text-sm text-text-secondary">
          Link expired?{" "}
          <Link to="/forgot-password" className="text-accent-strong hover:underline">Request a new one</Link>
        </p>
      </Card>
    </div>
  );
}
