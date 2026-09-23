import { useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, endpoints, errorCode } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { useAsyncAction } from "../lib/useAsyncAction";
import { AUTH_SUBLINE, RESET, checkFields } from "../lib/authCopy";
import { AuthMark, AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { PasswordInput } from "../components/PasswordInput";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { TextLink } from "../components/ui/text-link";
import { SealCheck } from "../components/ui/icons";

type Errors = { password?: string; confirm?: string };

function validate(password: string, confirm: string): Errors {
  if (!password) return { password: RESET.enterNew };
  if (password.length < 8) return { password: RESET.tooShort };
  if (!confirm) return { confirm: RESET.enterConfirm };
  if (password !== confirm) return { confirm: RESET.mismatch };
  return {};
}

/**
 * The API answers 400 for a token that is expired, already used or simply wrong — one answer on
 * purpose, because distinguishing them would tell a guesser which tokens exist. The member's
 * repair is the same in all three cases, so one sentence covers it. A short password is the one
 * 400 that is about a field.
 */
function describeReset(err: unknown): { field?: Errors; message?: string } {
  if (err instanceof ApiError && err.status === 400 && errorCode(err) === "password_too_short") {
    return { field: { password: RESET.tooShort } };
  }
  if (err instanceof ApiError && err.status === 400) return { message: RESET.spent };
  if (err instanceof ApiError && err.status === 429) return { message: RESET.rateLimited };
  return { message: describeFailure(err, { action: "reset your password" }) };
}

function Done() {
  return (
    <AuthShell className="my-auto" subline={AUTH_SUBLINE.password} mark={<AuthMark icon={SealCheck} tone="success" />}
      title={RESET.doneTitle} lead={RESET.done}>
      <Button asChild block><Link to="/login">{RESET.signIn}</Link></Button>
    </AuthShell>
  );
}

/**
 * Self-service password reset, step two — the destination of the link in the email
 * (`AuthService` builds `{PublicBaseUrl}/reset-password/{token}`).
 */
export default function ResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const refuse = (found: Errors) => {
    setErrors(found);
    if (found.password) passwordRef.current?.focus();
    else if (found.confirm) confirmRef.current?.focus();
  };

  const save = useAsyncAction((t: string, p: string) => endpoints.resetPassword(t, p), {
    success: () => setDone(true),
    failure: (err) => {
      const { field, message } = describeReset(err);
      if (field) refuse(field);
      setFailure(message ?? null);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFailure(null);
    const found = validate(password, confirm);
    refuse(found);
    if (found.password || found.confirm) return;
    if (!token) { setFailure(RESET.incomplete); return; }
    void save.run(token, password);
  };

  if (done) return <Done />;

  const problems = Object.values(errors).filter(Boolean).length;
  return (
    <AuthShell
      className="my-auto"
      subline={AUTH_SUBLINE.password}
      title={RESET.title}
      lead={RESET.lead}
      footer={<>{RESET.expired}{" "}<TextLink to="/forgot-password" className="py-3">{RESET.requestNew}</TextLink></>}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Field>
          <FieldLabel>{RESET.newPassword}</FieldLabel>
          <PasswordInput ref={passwordRef} required autoComplete="new-password" value={password}
            onChange={(e) => { setPassword(e.target.value); setErrors((w) => ({ ...w, password: undefined })); }} />
          <FieldDescription>{RESET.hint}</FieldDescription>
          <FieldError>{errors.password}</FieldError>
        </Field>
        <Field>
          <FieldLabel>{RESET.confirm}</FieldLabel>
          <PasswordInput ref={confirmRef} required autoComplete="new-password" value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setErrors((w) => ({ ...w, confirm: undefined })); }} />
          <FieldError>{errors.confirm}</FieldError>
        </Field>
        {problems > 0 ? <Alert>{checkFields(problems)}</Alert> : null}
        {failure ? <Alert>{failure}</Alert> : null}
        <Button type="submit" block pending={save.pending}>{RESET.submit}</Button>
      </form>
    </AuthShell>
  );
}
