import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, endpoints, errorCode } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Card } from "../components/Card";
import { Button, Input, Label } from "../components/Button";

/**
 * The API's refusal codes, as sentences. A member never sees a code, and never sees the same
 * sentence for two different mistakes — which is the failure this whole round is about.
 */
const MESSAGES: Record<string, string> = {
  current_password_incorrect: "That's not your current password. Try again.",
  password_unchanged: "Your new password has to be different from your current one.",
  password_too_short: "Your new password must be at least 8 characters.",
  missing_fields: "Fill in both your current and your new password.",
  no_password_set: "This account signs in with a passkey and has no password to change. Use “Forgot password?” on the sign-in screen to set one.",
};

/**
 * The form a member uses to replace their own password. Shared, because it is reached two ways:
 * from Profile by choice, and — when an admin has issued a temporary password — as the only
 * screen the session can reach at all.
 */
export function ChangePasswordForm({ onDone, forced }: { onDone?: () => void; forced?: boolean }) {
  const auth = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) { setError("The two new passwords don't match."); return; }
    if (next.length < 8) { setError("Your new password must be at least 8 characters."); return; }
    if (next === current) { setError("Your new password has to be different from your current one."); return; }

    setSaving(true);
    try {
      await endpoints.changePassword(current, next);
      auth.passwordChanged();
      setCurrent(""); setNext(""); setConfirm("");
      toast.push({ tone: "success", text: "Password changed." });
      onDone?.();
    } catch (err) {
      const code = errorCode(err);
      if (code && MESSAGES[code]) setError(MESSAGES[code]);
      else if (err instanceof ApiError && err.status === 429) setError("Too many attempts. Wait a minute, then try again.");
      else setError("Couldn't change your password. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <Label htmlFor="currentPassword">{forced ? "Temporary password" : "Current password"}</Label>
        <Input
          id="currentPassword" type="password" required value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password"
        />
      </div>
      <div>
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword" type="password" required minLength={8} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password"
        />
        <p className="text-xs text-text-muted mt-1">At least 8 characters, and different from your current one.</p>
      </div>
      <div>
        <Label htmlFor="confirmPassword">Confirm new password</Label>
        <Input
          id="confirmPassword" type="password" required minLength={8} value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
        />
      </div>
      {error && <p className="text-sm text-danger-strong">{error}</p>}
      <Button type="submit" disabled={saving} className="w-full">{saving ? "Saving…" : "Change password"}</Button>
    </form>
  );
}

/**
 * `/change-password` — the forced-change destination.
 *
 * <p>
 * An admin-issued temporary password is emailed in plaintext and shown on an admin's screen, and
 * the spec has always called it single-use and forced-reset. Nothing enforced either: it simply
 * became the account's password. `PasswordChangeGate` on the API is the enforcement; this screen
 * is what makes that enforcement navigable rather than a 403 on every page.
 * </p>
 *
 * <p>
 * Reachable deliberately as well, from Profile — a member who just wants to change their password
 * gets the same form without the banner.
 * </p>
 */
export default function ChangePasswordPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const forced = auth.status === "authenticated" && auth.mustChangePassword;

  return (
    <div className="max-w-md mx-auto pt-6">
      <Card>
        <h1 className="text-xl font-semibold mb-1">{forced ? "Choose your own password" : "Change your password"}</h1>
        {/*
          N-F10: this said "the one you just used is temporary", and this screen has three
          arrivals and only one of them used anything. A member who clicked the welcome magic
          link did not type a password at all; a member whose password an admin reset while
          they were signed in did not either (L-F4 routes them here mid-session). Naming the
          temporary password as a thing that EXISTS is true in all three, and the link below
          is what a member who has not got it can actually do — before, they had to know that
          "Forgot password?" on the sign-in screen was the way out of a screen that does not
          mention it.
        */}
        <p className="text-sm text-text-secondary mb-5">
          {forced
            ? "An admin has reset your password, so the one on your account is a temporary one they issued. Choose your own to carry on — the temporary one stops working the moment you do."
            : "You'll need your current password to set a new one."}
        </p>
        <ChangePasswordForm forced={forced} onDone={() => nav(forced ? "/schedule" : "/profile")} />
        {forced && (
          <p className="text-sm text-text-secondary mt-4">
            Haven't got the temporary password?{" "}
            <Link to="/forgot-password" className="text-accent-strong hover:underline">Email yourself a reset link</Link>{" "}
            instead.
          </p>
        )}
      </Card>
    </div>
  );
}
