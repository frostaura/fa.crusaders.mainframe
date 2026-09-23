import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { endpoints } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../components/Toast";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { TextLink } from "../components/ui/text-link";
import { describeFailure } from "../lib/errors";
import { LANDING_PATH } from "../components/shell/nav";

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
export function ChangePasswordForm({ onDone, onCancel, forced }: { onDone?: () => void; onCancel?: () => void; forced?: boolean }) {
  const auth = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setError(null);
    if (next !== confirm) { setError(MISMATCH); return; }
    if (next.length < 8) { setError(MESSAGES.password_too_short); return; }
    if (next === current) { setError(MESSAGES.password_unchanged); return; }

    setSaving(true);
    try {
      await endpoints.changePassword(current, next);
      auth.passwordChanged();
      setCurrent(""); setNext(""); setConfirm("");
      toast.push({ tone: "success", text: "Password changed." });
      onDone?.();
    } catch (err) {
      setError(describeFailure(err, { codes: MESSAGES, action: "change your password" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field controlId="currentPassword">
        <FieldLabel>{forced ? "Temporary password" : "Current password"}</FieldLabel>
        <Input
          type="password" required value={current}
          onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password"
        />
      </Field>
      <Field controlId="newPassword">
        <FieldLabel>New password</FieldLabel>
        <Input
          type="password" required minLength={8} value={next}
          onChange={(e) => setNext(e.target.value)} autoComplete="new-password"
        />
        <FieldDescription>At least 8 characters, and different from your current one.</FieldDescription>
      </Field>
      <Field controlId="confirmPassword">
        <FieldLabel>Confirm new password</FieldLabel>
        <Input
          type="password" required minLength={8} value={confirm}
          onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password"
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button> : null}
        <Button type="submit" pending={saving} block={!onCancel}>Change password</Button>
      </div>
    </form>
  );
}

const MISMATCH = "The two new passwords don't match.";
const FORCED_LEAD = "Your account is on a temporary password. Choose your own to carry on — the temporary one stops working the moment you do.";
const CHOSEN_LEAD = "You'll need your current password to set a new one.";

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
    <PageShell width="narrow">
      {/*
        N-F10: the forced lead deliberately does NOT say "an admin has reset your password" — the
        first person ever to sign in to a club was created by ProductionBootstrap with
        must-change-password set, and nobody reset anything. The one meaning the screen can rely
        on is that the current password is temporary.
      */}
      <PageHeader
        back={forced ? undefined : { to: "/profile", label: "Profile" }}
        title={forced ? "Choose your own password" : "Change your password"}
        description={forced ? FORCED_LEAD : CHOSEN_LEAD}
      />
      <Card className="px-4 sm:px-6">
        <ChangePasswordForm forced={forced} onDone={() => nav(forced ? LANDING_PATH : "/profile")} />
      </Card>
      {/*
        This screen has three arrivals and only one of them typed a password: a member who
        clicked the welcome magic link, or whose password an admin reset mid-session (L-F4),
        has none to type. The way out for them is a reset link.
      */}
      {forced && (
        <p className="text-sm text-text-secondary">
          {"Haven't got the temporary password? "}
          <TextLink to="/forgot-password">Email yourself a reset link</TextLink>
          {" instead."}
        </p>
      )}
    </PageShell>
  );
}
