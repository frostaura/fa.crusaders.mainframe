import { useRef, useState, type FormEvent, type Ref, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { endpoints, errorCode } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAsyncAction } from "../lib/useAsyncAction";
import { describeFailure } from "../lib/errors";
import { CHANGE_PASSWORD, CHANGE_PASSWORD_MESSAGES, checkFields } from "../lib/authCopy";
import { Alert } from "../components/Alert";
import { PasswordInput } from "../components/PasswordInput";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { TextLink } from "../components/ui/text-link";
import { LANDING_PATH } from "../components/shell/nav";

type Key = "current" | "next" | "confirm";
type Values = Record<Key, string>;
type Errors = Partial<Record<Key, string>>;

const ORDER: Key[] = ["current", "next", "confirm"];

/** The API's refusals that are about one field; the rest are about the change as a whole. */
const FIELD_OF_CODE: Record<string, Key> = {
  current_password_incorrect: "current",
  password_unchanged: "next",
  password_too_short: "next",
};

function validate({ current, next, confirm }: Values): Errors {
  const errors: Errors = {};
  if (!current) errors.current = CHANGE_PASSWORD.enterCurrent;
  if (!next) errors.next = CHANGE_PASSWORD.enterNew;
  else if (next.length < 8) errors.next = CHANGE_PASSWORD_MESSAGES.password_too_short;
  else if (next === current) errors.next = CHANGE_PASSWORD_MESSAGES.password_unchanged;
  if (next && !errors.next && next !== confirm) errors.confirm = CHANGE_PASSWORD.mismatch;
  return errors;
}

type PasswordFieldProps = {
  label: string;
  hint?: string;
  error?: string;
  value: string;
  autoComplete: string;
  onChange: (value: string) => void;
  ref: Ref<HTMLInputElement>;
};

function PasswordField(props: PasswordFieldProps) {
  const { label, hint, error, value, autoComplete, onChange, ref } = props;
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <PasswordInput ref={ref} required autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}

type Refs = Record<Key, RefObject<HTMLInputElement | null>>;

/** Values, per-field complaints, and the keyboard taken to the first field that is wrong. */
function usePasswordForm(refs: () => Refs) {
  const [values, setValues] = useState<Values>({ current: "", next: "", confirm: "" });
  const [errors, setErrors] = useState<Errors>({});
  const refuse = (found: Errors) => {
    setErrors(found);
    const first = ORDER.find((key) => found[key]);
    if (first) refs()[first].current?.focus();
  };
  const set = (key: Key) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((was) => (was[key] ? { ...was, [key]: undefined } : was));
  };
  const clear = () => setValues({ current: "", next: "", confirm: "" });
  return { values, errors, refuse, set, clear };
}

type FormProps = { onDone?: () => void; onCancel?: () => void; forced?: boolean };

/**
 * The form a member uses to replace their own password. Shared, because it is reached two ways:
 * from Profile by choice, and — when a temporary password is in force — as the only screen the
 * session can reach at all.
 */
export function ChangePasswordForm({ onDone, onCancel, forced }: FormProps) {
  const auth = useAuth();
  // Separate refs, read only inside the handler that focuses one (react-hooks/refs).
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const form = usePasswordForm(() => ({ current: currentRef, next: nextRef, confirm: confirmRef }));
  const [failure, setFailure] = useState<string | null>(null);

  const change = useAsyncAction((current: string, next: string) => endpoints.changePassword(current, next), {
    success: () => {
      auth.passwordChanged();
      form.clear();
      onDone?.();
    },
    failure: (err) => {
      const field = FIELD_OF_CODE[errorCode(err) ?? ""];
      const message = describeFailure(err, { codes: CHANGE_PASSWORD_MESSAGES, action: "change your password" });
      if (field) form.refuse({ [field]: message });
      else setFailure(message);
    },
    toast: { success: CHANGE_PASSWORD.changed },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    const found = validate(form.values);
    form.refuse(found);
    if (Object.keys(found).length === 0) void change.run(form.values.current, form.values.next);
  };

  const problems = Object.values(form.errors).filter(Boolean).length;
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <PasswordField label={forced ? CHANGE_PASSWORD.temporary : CHANGE_PASSWORD.current} error={form.errors.current}
        value={form.values.current} onChange={form.set("current")} autoComplete="current-password" ref={currentRef} />
      <PasswordField label={CHANGE_PASSWORD.newPassword} hint={CHANGE_PASSWORD.newHint} error={form.errors.next}
        value={form.values.next} onChange={form.set("next")} autoComplete="new-password" ref={nextRef} />
      <PasswordField label={CHANGE_PASSWORD.confirm} error={form.errors.confirm}
        value={form.values.confirm} onChange={form.set("confirm")} autoComplete="new-password" ref={confirmRef} />
      {problems > 0 ? <Alert>{checkFields(problems)}</Alert> : null}
      {failure ? <Alert>{failure}</Alert> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel}>{CHANGE_PASSWORD.cancel}</Button> : null}
        <Button type="submit" pending={change.pending} block={!onCancel}>{CHANGE_PASSWORD.submit}</Button>
      </div>
    </form>
  );
}

/**
 * `/change-password` — the forced-change destination, and reachable by choice from Profile.
 *
 * <p>
 * An admin-issued temporary password is emailed in plaintext and shown on an admin's screen, and
 * the spec has always called it single-use and forced-reset. `PasswordChangeGate` on the API is
 * the enforcement; this screen is what makes that enforcement navigable rather than a 403 on
 * every page.
 * </p>
 */
export default function ChangePasswordPage() {
  const auth = useAuth();
  const nav = useNavigate();
  const forced = auth.status === "authenticated" && auth.mustChangePassword;

  return (
    <PageShell width="narrow">
      <PageHeader
        back={forced ? undefined : { to: "/profile", label: CHANGE_PASSWORD.back }}
        title={forced ? CHANGE_PASSWORD.forcedTitle : CHANGE_PASSWORD.chosenTitle}
        description={forced ? CHANGE_PASSWORD.forcedLead : CHANGE_PASSWORD.chosenLead}
      />
      <Card>
        <CardContent>
          <ChangePasswordForm forced={forced} onDone={() => nav(forced ? LANDING_PATH : "/profile")} />
        </CardContent>
      </Card>
      {/*
        Three arrivals and only one of them typed a password: a member who clicked the welcome
        magic link, or whose password an admin reset mid-session (L-F4), has none to type. The way
        out for them is a reset link.
      */}
      {forced ? (
        <p className="text-sm text-text-secondary">
          {CHANGE_PASSWORD.noTemporary}{" "}
          <TextLink to="/forgot-password">{CHANGE_PASSWORD.resetLink}</TextLink>
          {" "}{CHANGE_PASSWORD.instead}
        </p>
      ) : null}
    </PageShell>
  );
}
