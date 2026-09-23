import { useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { endpoints } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { useAsyncAction } from "../lib/useAsyncAction";
import { AUTH_SUBLINE, FIELD_REQUIRED, FORGOT } from "../lib/authCopy";
import { AuthMark, AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { Button } from "../components/ui/button";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { TextLink } from "../components/ui/text-link";
import { Envelope } from "../components/ui/icons";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Self-service password reset, step one.
 *
 * <p>
 * The confirmation deliberately does not say whether the address is registered. `POST
 * /auth/forgot-password` answers the same either way for the same reason: a screen that said
 * "no such account" would be an account-enumeration oracle sitting on an anonymous endpoint.
 * </p>
 */
function Sent({ email }: { email: string }) {
  return (
    <AuthShell className="my-auto" subline={AUTH_SUBLINE.password} mark={<AuthMark icon={Envelope} tone="success" />}
      title={FORGOT.sentTitle} lead={FORGOT.sent(email)}>
      <p className="rounded-lg bg-bg-muted px-4 py-3 text-sm text-text-secondary">{FORGOT.nothingArrived}</p>
      <Button asChild variant="outline" block className="mt-6">
        <Link to="/login">{FORGOT.back}</Link>
      </Button>
    </AuthShell>
  );
}

function emailProblem(email: string): string | undefined {
  if (!email.trim()) return FIELD_REQUIRED.email;
  if (!EMAIL_SHAPE.test(email.trim())) return FIELD_REQUIRED.emailFormat;
  return undefined;
}

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const send = useAsyncAction((address: string) => endpoints.forgotPassword(address), { success: () => setSent(true) });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = emailProblem(email);
    setFieldError(problem);
    if (problem) {
      input.current?.focus();
      return;
    }
    void send.run(email.trim());
  };

  if (sent) return <Sent email={email.trim()} />;

  return (
    <AuthShell
      className="my-auto"
      subline={AUTH_SUBLINE.password}
      title={FORGOT.title}
      lead={FORGOT.lead}
      footer={<>{FORGOT.remembered}{" "}<TextLink to="/login" className="py-3">{FORGOT.signIn}</TextLink></>}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Field>
          <FieldLabel>Email</FieldLabel>
          <Input
            ref={input} type="email" inputMode="email" required autoComplete="email"
            value={email} onChange={(e) => { setEmail(e.target.value); setFieldError(undefined); }}
          />
          <FieldError>{fieldError}</FieldError>
        </Field>
        {send.status === "error" ? <Alert>{describeFailure(send.error, { action: "send the reset email" })}</Alert> : null}
        <Button type="submit" block pending={send.pending}>{FORGOT.submit}</Button>
      </form>
    </AuthShell>
  );
}
