import { useState } from "react";
import { Link } from "react-router-dom";
import { endpoints } from "../lib/api";
import { AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { Button, Input, Label } from "../components/Button";
import { describeFailure } from "../lib/errors";

/**
 * Self-service password reset, step one.
 *
 * <p>
 * The link to this screen has been on `/login` since the beginning and the endpoints behind it
 * have existed all along — but the route did not, so `App.tsx`'s catch-all sent a locked-out
 * member to the marketing home page with no error and no way back into their account. The whole
 * feature was one `&lt;Route&gt;` away from working.
 * </p>
 *
 * <p>
 * The confirmation deliberately does not say whether the address is registered. `POST
 * /auth/forgot-password` answers the same either way for the same reason: a screen that said
 * "no such account" would be an account-enumeration oracle sitting on an anonymous endpoint.
 * </p>
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await endpoints.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(describeFailure(err, { action: "send the reset email" }));
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthShell className="my-auto" subline="Set a new password for your club account.">
        <>
          <h1 className="text-lg font-semibold mb-2">Check your inbox</h1>
          <p className="text-sm text-text-secondary mb-4">
            If <span className="font-medium">{email.trim()}</span> belongs to an account, we've emailed a link to
            set a new password. It works once, and expires in an hour.
          </p>
          <p className="text-sm text-text-secondary mb-4">
            Nothing arrived? Check spam, then ask the club committee — they can issue you a temporary password.
          </p>
          <Link to="/login" className="text-accent-strong hover:underline text-sm">Back to sign in</Link>
        </>
    </AuthShell>
    );
  }

  return (
    <AuthShell className="my-auto" subline="Set a new password for your club account.">
      <>
        <h1 className="text-lg font-semibold mb-1">Reset your password</h1>
        <p className="text-sm text-text-secondary mb-5">
          Enter the email address you registered with and we'll send you a link to set a new password.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          {error && (
            <Alert>
              {error}
            </Alert>
          )}
          <Button type="submit" variant="primary" loading={loading} className="w-full">
            {loading ? "Sending…" : "Send reset link"}
          </Button>
        </form>
        <p className="mt-4 text-sm text-text-secondary">
          Remembered it?{" "}
          <Link to="/login" className="text-accent-strong hover:underline">Sign in</Link>
        </p>
      </>
    </AuthShell>
  );
}
