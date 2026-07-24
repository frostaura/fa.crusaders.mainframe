import { useState } from "react";
import { Fingerprint } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { isPasskeySupported } from "../lib/webauthn";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

// Seeded by Seeder.cs in Development. Hidden behind import.meta.env.DEV so it disappears in prod builds.
const DEV_ADMIN_EMAIL = "any@frostaura.net";
const DEV_ADMIN_PASSWORD = "ChangeMeOnFirstLogin!";

export default function LoginPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const doLogin = async (e: string, p: string) => {
    setError(null);
    setLoading(true);
    try {
      await auth.login(e, p);
      nav("/schedule");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setError("Email or password is incorrect.");
        else if (err.status === 403) setError("Your account isn't approved yet.");
        else setError("Sign in failed.");
      } else setError("Network error.");
    } finally {
      setLoading(false);
    }
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
      nav("/schedule");
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
      nav("/schedule");
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

