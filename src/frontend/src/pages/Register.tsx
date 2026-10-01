import { useRef, useState, type FormEvent, type Ref, type RefObject } from "react";
import { Link } from "react-router-dom";
import { endpoints, errorCode, uploadPhoto } from "../lib/api";
import { describeFailure, isDeploymentFault } from "../lib/errors";
import { useAsyncAction } from "../lib/useAsyncAction";
import { checkFields } from "../lib/authCopy";
import { AuthMark, AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { PasswordInput } from "../components/PasswordInput";
import { PhotoPicker, type PhotoPickerHandle } from "../components/PhotoPicker";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { TextLink } from "../components/ui/text-link";
import { Envelope } from "../components/ui/icons";
import { PendingInviteNote } from "../components/players/invites/PendingInviteNote";
import {
  INBOX_HEADING, INBOX_PATIENCE, INBOX_STEPS, PHOTO_PREPARING, PHOTO_REQUIRED, REGISTER, REGISTER_FIELD,
  REGISTER_MESSAGES, VERIFY_BACK_TO_SIGN_IN,
} from "../lib/registrationCopy";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Values = { fullName: string; email: string; membershipNumber: string; password: string };
type Key = keyof Values | "photo";
type Errors = Partial<Record<Key, string>>;

/** The order the fields appear in — the first one wrong is where the keyboard goes. */
const ORDER: Key[] = ["fullName", "email", "membershipNumber", "password", "photo"];

/** Which field an API refusal is about. Anything not listed is about the application as a whole. */
const FIELD_OF_CODE: Record<string, Key> = {
  email_in_use: "email",
  membership_number_in_use: "membershipNumber",
  password_too_short: "password",
  unsupported_content_type: "photo",
  file_too_large: "photo",
  file_missing: "photo",
  expected_multipart: "photo",
};

function validate(values: Values, photo: File | null, preparing: boolean): Errors {
  const errors: Errors = {};
  if (values.fullName.trim().length < 2) errors.fullName = REGISTER_FIELD.fullName;
  if (!values.email.trim()) errors.email = REGISTER_FIELD.email;
  else if (!EMAIL_SHAPE.test(values.email.trim())) errors.email = REGISTER_FIELD.emailFormat;
  if (!values.membershipNumber.trim()) errors.membershipNumber = REGISTER_FIELD.membershipNumber;
  if (!values.password) errors.password = REGISTER_FIELD.password;
  else if (values.password.length < 8) errors.password = REGISTER_FIELD.passwordShort;
  // Distinct from having no photo: telling somebody watching their photo being prepared that
  // they have not chosen one is simply false.
  if (preparing) errors.photo = PHOTO_PREPARING;
  else if (!photo) errors.photo = PHOTO_REQUIRED;
  return errors;
}

/** The three steps and the wait, on the screen an applicant lands on the moment it is sent. */
function Submitted() {
  return (
    <AuthShell
      className="my-auto"
      subline={REGISTER.submittedSubline}
      mark={<AuthMark icon={Envelope} tone="success" />}
      title={INBOX_HEADING}
    >
      <ol className="flex flex-col gap-3">
        {/* The steps, because "an admin reviews your application" left an applicant with no idea
            whether anything more was needed of them, or how long to wait before assuming it failed. */}
        {INBOX_STEPS.map((step, i) => (
          <li key={step} className="flex gap-3 text-sm text-text-primary">
            <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold tabular-nums text-accent-strong">
              {i + 1}
            </span>
            <span className="pt-0.5">{step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-5 rounded-lg bg-bg-muted px-4 py-3 text-sm text-text-secondary">{INBOX_PATIENCE}</p>
      {/* R1 F2.3 — arrived by an invite link: it is kept for after approval. */}
      <div className="mt-4"><PendingInviteNote stage="verified" /></div>
      {/* R10 — somewhere else to go is a link, dressed as the one call to action on the screen. */}
      <Button asChild variant="outline" block className="mt-6">
        <Link to="/login">{VERIFY_BACK_TO_SIGN_IN}</Link>
      </Button>
    </AuthShell>
  );
}

type TextFieldProps = {
  id: keyof Values;
  label: string;
  hint?: string;
  error?: string;
  ref: Ref<HTMLInputElement>;
  input: Omit<React.ComponentProps<"input">, "id" | "ref">;
};

function TextField(props: TextFieldProps) {
  const { id, label, hint, error, ref, input } = props;
  return (
    <Field controlId={id}>
      <FieldLabel>{label}</FieldLabel>
      {id === "password" ? <PasswordInput ref={ref} required {...input} /> : <Input ref={ref} required {...input} />}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}

type FieldRefs = {
  fullName: RefObject<HTMLInputElement | null>;
  email: RefObject<HTMLInputElement | null>;
  membershipNumber: RefObject<HTMLInputElement | null>;
  password: RefObject<HTMLInputElement | null>;
  photo: RefObject<PhotoPickerHandle | null>;
};

function useRegisterForm(refs: () => FieldRefs) {
  const [values, setValues] = useState<Values>({ fullName: "", email: "", membershipNumber: "", password: "" });
  // Already prepared by PhotoPicker at the moment it was chosen — a small, correctly-rotated JPEG.
  const [photo, setPhoto] = useState<File | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  /** Refuse, say why on each field, and take the member to the first one. Never silently. */
  const refuse = (found: Errors) => {
    setErrors(found);
    const first = ORDER.find((key) => found[key]);
    if (first) refs()[first].current?.focus();
  };
  // Editing a field answers its complaint; the rest stay until the next submit re-checks them.
  const set = (key: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((was) => (was[key] ? { ...was, [key]: undefined } : was));
  };
  return { values, photo, setPhoto, preparing, setPreparing, errors, setErrors, refuse, set };
}

export default function RegisterPage() {
  // Separate refs, read only inside the handler that focuses one (react-hooks/refs).
  const fullNameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const membershipRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const photoRef = useRef<PhotoPickerHandle>(null);
  const form = useRegisterForm(() => ({
    fullName: fullNameRef, email: emailRef, membershipNumber: membershipRef, password: passwordRef, photo: photoRef,
  }));
  const { values, errors } = form;
  const [submitted, setSubmitted] = useState(false);
  /** The application as a whole was refused — what the club's system said, not what the form noticed. */
  const [failure, setFailure] = useState<string | null>(null);
  /** The failure is the club's to fix (a missing tenant, a 5xx), so resubmitting cannot cure it. */
  const [blocked, setBlocked] = useState(false);

  const send = useAsyncAction(async (photo: File) => {
    const upload = await uploadPhoto(photo);
    await endpoints.register({ ...values, photoUrl: upload.url });
  }, {
    success: () => setSubmitted(true),
    failure: (err) => {
      const field = FIELD_OF_CODE[errorCode(err) ?? ""];
      const message = describeFailure(err, { codes: REGISTER_MESSAGES, action: "submit your application" });
      if (field) form.refuse({ [field]: message });
      else setFailure(message);
      setBlocked(isDeploymentFault(err));
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (send.pending) return;
    setFailure(null);
    const found = validate(values, form.photo, form.preparing);
    form.refuse(found);
    if (Object.keys(found).length === 0 && form.photo) void send.run(form.photo);
  };

  if (submitted) return <Submitted />;

  const problems = Object.values(errors).filter(Boolean).length;
  return (
    // Top-aligned, NOT centred: this card is tall, and centring it pushes the club band off the top
    // of a 360x640 viewport — the one thing that tells an applicant whose page they are handing a
    // photograph of their face to.
    <AuthShell
      size="wide"
      subline={REGISTER.subline}
      title={REGISTER.title}
      footer={<>{REGISTER.haveAccount}{" "}<TextLink to="/login" className="py-3">{REGISTER.signIn}</TextLink></>}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <PendingInviteNote stage="join" />
        {/* R4 form factor (SPEC 3.17): from a 34rem card the photo stands beside the fields
            rather than under them; the order (fields, then photo) is the same in both. */}
        <div className="grid gap-5 @[34rem]/auth:grid-cols-2 @[34rem]/auth:items-start">
          <div className="flex min-w-0 flex-col gap-5">
            <TextField id="fullName" label={REGISTER.fullName} error={errors.fullName} ref={fullNameRef}
              input={{ value: values.fullName, onChange: form.set("fullName"), autoComplete: "name" }} />
            <TextField id="email" label={REGISTER.email} error={errors.email} ref={emailRef}
              input={{ type: "email", inputMode: "email", value: values.email, onChange: form.set("email"), autoComplete: "email" }} />
            <TextField id="membershipNumber" label={REGISTER.membershipNumber} hint={REGISTER.membershipHint}
              error={errors.membershipNumber} ref={membershipRef}
              input={{ value: values.membershipNumber, onChange: form.set("membershipNumber"), autoComplete: "off" }} />
            <TextField id="password" label={REGISTER.password} hint={REGISTER.passwordHint} error={errors.password}
              ref={passwordRef}
              input={{ value: values.password, onChange: form.set("password"), autoComplete: "new-password" }} />
          </div>
          <div className="min-w-0">
            <PhotoPicker
              ref={photoRef}
              value={form.photo}
              // Choosing one answers the complaint, so it goes at that moment, not at the next submit.
              onChange={(file) => { form.setPhoto(file); form.setErrors((was) => ({ ...was, photo: undefined })); }}
              error={errors.photo}
              onBusyChange={form.setPreparing}
              required
            />
          </div>
        </div>
        {/* ONE live region per refusal: this summary speaks; the fields carry the detail and the
            keyboard has already been taken to the first of them. */}
        {problems > 0 ? <Alert>{checkFields(problems)}</Alert> : null}
        {failure ? <Alert>{failure}</Alert> : null}
        {/* Hidden, not disabled, when only the club can fix what went wrong: a button that invites
            pressing against a fault resubmitting cannot clear is a lie. */}
        {!blocked ? <Button type="submit" size="lg" block pending={send.pending}>{REGISTER.submit}</Button> : null}
      </form>
    </AuthShell>
  );
}
