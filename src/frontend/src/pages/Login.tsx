import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth, type SessionEnding } from "../lib/useAuth";
import { ApiError, endpoints, errorCode } from "../lib/api";
import { isPasskeySupported } from "../lib/webauthn";
import { useAsyncAction } from "../lib/useAsyncAction";
import { AuthDivider, AuthShell } from "../components/AuthShell";
import { Alert } from "../components/Alert";
import { PasswordInput } from "../components/PasswordInput";
import { Button } from "../components/ui/button";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { TextLink } from "../components/ui/text-link";
import { Envelope, Fingerprint, Phone } from "../components/ui/icons";
import { AUTH_SUBLINE, FIELD_REQUIRED, LOGIN, LOGIN_REFUSAL } from "../lib/authCopy";
import { LANDING_PATH } from "../components/shell/nav";
import { SIGNED_IN_ARRIVAL } from "../lib/onboarding";
import { pendingInvitePath } from "../lib/playersPending";

// Seeded by Seeder.cs in Development. Hidden behind import.meta.env.DEV so it disappears in prod builds.
const DEV_ADMIN_EMAIL = "any@frostaura.net";
const DEV_ADMIN_PASSWORD = "ChangeMeOnFirstLogin!";

/** Half of what a line is short of a 44px target, as a negative margin: -12px at 14px text, ~0 at 200 %. */
const FORGOT_OVERHANG = { marginBlock: "min(0px, calc((1lh - 44px) / 2))" } as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A refused sign-in, told apart by the membership status the API sends with it.
 *
 * <p>
 * `status` is on the refusal body (`{"error":"not_approved","status":"Suspended"}`) and the
 * screen used to throw it away, answering all three with "isn't approved yet — an admin will
 * email you", which was false for a suspended member and for a rejected applicant. Each sentence
 * now names what happened and who can undo it; only the genuinely pending case is asked to wait.
 * </p>
 */
function describeNotApproved(status: string | number | null): string {
  if (status === "Suspended") return LOGIN_REFUSAL.suspended;
  if (status === "Rejected") return LOGIN_REFUSAL.rejected;
  return LOGIN_REFUSAL.pending;
}

function describeFailure(err: unknown): string {
  if (!(err instanceof ApiError)) return LOGIN_REFUSAL.network;
  if (err.status === 401) return LOGIN_REFUSAL.credentials;
  if (err.status === 429) return LOGIN_REFUSAL.rateLimited;
  if (err.status === 403 && errorCode(err) === "email_not_verified") return LOGIN_REFUSAL.unverified;
  if (err.status === 403) return describeNotApproved(err.detail("status"));
  return LOGIN_REFUSAL.generic;
}

type Contact = { phone: string | null; email: string | null };

/**
 * The club's public contact, off the `not_approved` refusal body — and nowhere else.
 *
 * <p>
 * Every not-approved sentence ends by telling the member to talk to the club, and a member
 * stopped at sign-in can reach no API that knows a club's number. The API attaches the PUBLIC
 * contact to this one 403 only, returned to somebody who has already proved they hold a real
 * account's credentials, so the login endpoint is no harvesting oracle. Absent, null, blank or
 * the wrong type renders nothing: "Call the club on null" is worse than silence.
 * </p>
 */
function refusalContact(err: unknown): Contact | null {
  if (!(err instanceof ApiError) || errorCode(err) !== "not_approved") return null;
  const payload = err.payload;
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as { contact?: unknown }).contact;
  if (!raw || typeof raw !== "object") return null;
  const text = (key: "phone" | "email") => {
    const value = (raw as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const phone = text("phone");
  const email = text("email");
  return phone || email ? { phone, email } : null;
}

/**
 * The two ways to reach the club, or nothing. BESIDE the refusal, not inside it: the refusal is
 * `role="alert"` and announces over everything the instant it appears, which is right for the
 * refusal and wrong for two links the member has not reached yet.
 */
function RefusalContact({ contact }: { contact: Contact }) {
  return (
    <div className="rounded-lg border border-border bg-bg-muted px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{LOGIN.contactHeading}</p>
      <ul className="mt-1 flex flex-col">
        {contact.phone ? (
          <li className="flex min-h-touch items-center gap-2">
            <Phone size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
            {/* Spaces in a number are for reading, not for dialling. */}
            <TextLink href={`tel:${contact.phone.replace(/\s+/g, "")}`}>{contact.phone}</TextLink>
          </li>
        ) : null}
        {contact.email ? (
          <li className="flex min-h-touch items-center gap-2">
            <Envelope size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
            <TextLink href={`mailto:${contact.email}`} className="break-all">{contact.email}</TextLink>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * How the last session in this tab ended, taken ONCE when the page opens and then cleared from
 * the provider (D7, D11). Held in the page's own state so the notice survives the clear, and
 * cleared so a LATER redirect to /login in the same visit — an anonymous member opening a
 * shared invite link — carries its `from` as it always did.
 */
function useCapturedEnding(): SessionEnding | null {
  const auth = useAuth();
  const [ending] = useState(() => auth.sessionEnding);
  const { sessionEnding, clearSessionEnding } = auth;
  useEffect(() => { if (sessionEnding) clearSessionEnding(); }, [sessionEnding, clearSessionEnding]);
  return ending;
}

/**
 * Where to land after signing in, and — when the page was someone's — whose it was. `asked` is
 * false when nobody asked for a page (the default landing), which is when a waiting invite this
 * device opened may be resurfaced instead (R1 F2 — the first sign-in after approval).
 */
type ReturnPath = { path: string; onlyFor: string | null; asked: boolean };

/**
 * The page the member actually asked for, captured by `RequireAuth` when it turned them away.
 * Only ever an in-app path: a `from` carrying an absolute URL would make this an open redirect.
 *
 * <p>
 * <b>D11 — never the last person's page.</b> After a deliberate sign-out the guard still
 * captured the page being left, and the next person to sign in on that phone landed on the
 * previous member's `/profile`. A sign-out drops the `from`; an expiry keeps it only for the
 * member whose session it was.
 * </p>
 */
function useReturnPath(ending: SessionEnding | null): ReturnPath {
  const location = useLocation();
  // …unless the sign-out was asked for so that somebody else could open a page (D5).
  if (ending?.kind === "signed-out") return { path: ending.returnTo ?? LANDING_PATH, onlyFor: null, asked: !!ending.returnTo };
  const path = inAppPath(location.state as { from?: { pathname?: string; search?: string } } | null);
  if (path === null) return { path: LANDING_PATH, onlyFor: null, asked: false };
  return { path, onlyFor: ending?.userId ?? null, asked: true };
}

/** The guard's captured `from`, when it is an in-app path other than /login; otherwise null. */
function inAppPath(state: { from?: { pathname?: string; search?: string } } | null): string | null {
  const path = state?.from?.pathname;
  if (!path || !path.startsWith("/") || path.startsWith("//") || path === "/login") return null;
  return `${path}${state?.from?.search ?? ""}`;
}

/**
 * The sentence "Sign out everywhere" hands over (member-code §10): that session ended on purpose,
 * on every device, so this page says so rather than presenting a blank form — and says it as a
 * fact, not as the "your session ended" commiseration an expiry gets. From the provider first
 * (see {@link useCapturedEnding}); router state is kept as a second source.
 */
function useSignedOutNotice(ending: SessionEnding | null): string | null {
  const location = useLocation();
  const notice = (location.state as { signedOutNotice?: unknown } | null)?.signedOutNotice;
  if (ending?.notice) return ending.notice;
  return typeof notice === "string" ? notice : null;
}

type FieldErrors = { email?: string; password?: string };

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!email.trim()) errors.email = FIELD_REQUIRED.email;
  else if (!EMAIL_SHAPE.test(email.trim())) errors.email = FIELD_REQUIRED.emailFormat;
  if (!password) errors.password = FIELD_REQUIRED.password;
  return errors;
}

/**
 * `email_not_verified` is the one refusal the member can repair from here: offer the resend,
 * then say what it did. Reported as sent either way, deliberately — the endpoint answers the same
 * for an address it has never seen, and a screen that distinguished them would put the
 * enumeration oracle back.
 */
function ResendConfirmation({ email, onNeedEmail }: { email: string; onNeedEmail: () => void }) {
  const [sent, setSent] = useState(false);
  const resend = useAsyncAction(async () => {
    try { await endpoints.resendVerification(email.trim()); } catch { /* neutral — see above */ }
  }, { success: () => setSent(true) });
  if (sent) return <Alert tone="info" live="polite">{LOGIN.resent}</Alert>;
  // The address was cleared after the refusal: say where the link would go, never "Sent" to nobody.
  const press = () => (email.trim() ? void resend.run() : onNeedEmail());
  return (
    <Button type="button" variant="outline" block pending={resend.pending} onClick={press}>
      {LOGIN.resend}
    </Button>
  );
}

type Refusal = { message: string; contact: Contact | null; offerResend: boolean };

function refusalOf(err: unknown): Refusal {
  return {
    message: describeFailure(err),
    contact: refusalContact(err),
    offerResend: err instanceof ApiError && err.status === 403 && errorCode(err) === "email_not_verified",
  };
}

function passkeyRefusal(err: unknown): Refusal | null {
  if (err instanceof Error && err.message === "passkey_cancelled") return null; // the member dismissed it
  const message = err instanceof ApiError && err.status === 401 ? LOGIN_REFUSAL.passkeyUnknown : LOGIN_REFUSAL.passkeyFailed;
  return { message, contact: null, offerResend: false };
}

/**
 * Development only, and it must stay that way: `production-posture.test` builds the release
 * bundle and fails if either string or the seeded password reaches it. Everything that names
 * them lives inside this component, which is referenced only behind `import.meta.env.DEV`, so
 * the minifier drops it whole — a string hoisted into `authCopy` would ship.
 */
function DevShortcut({ onLanded, onRefused }: { onLanded: () => void; onRefused: (refusal: Refusal) => void }) {
  const auth = useAuth();
  const dev = useAsyncAction(async () => {
    try {
      await auth.loginAsSeededAdmin();
    } catch {
      // The dev endpoint is off (a non-Development API): fall back to the seeded credentials.
      await auth.login(DEV_ADMIN_EMAIL, DEV_ADMIN_PASSWORD);
    }
  }, { success: onLanded, failure: (err) => onRefused(refusalOf(err)) });
  return (
    <div className="mt-6 border-t border-dashed border-border pt-4">
      <p className="mb-2 text-xs font-medium text-text-muted">Dev shortcuts</p>
      <Button variant="outline" type="button" block pending={dev.pending} onClick={() => void dev.run()}>
        Sign in as seeded admin
      </Button>
      <p className="mt-2 break-all font-mono text-xs text-text-muted">{DEV_ADMIN_EMAIL} · {DEV_ADMIN_PASSWORD}</p>
    </div>
  );
}

/** Two ways in, one at a time. Re-entry from any of them is ignored while another runs. */
function useSignIn(onRefused: (refusal: Refusal | null) => void, ending: SessionEnding | null) {
  const auth = useAuth();
  const nav = useNavigate();
  const from = useReturnPath(ending);
  const land = (userId?: string) => {
    auth.clearSessionExpired();
    const theirs = from.onlyFor === null || from.onlyFor === userId;
    // R1 F2 — nobody asked for a page: an invite this device is waiting to answer comes first.
    const invite = from.asked ? null : pendingInvitePath(userId ?? null);
    // F4.8 — the state is what lets the first-run gate offer the wizard HERE, after a sign-in,
    // and never to a member who opened My Code at a door.
    nav(invite ?? (theirs ? from.path : LANDING_PATH), { replace: true, state: SIGNED_IN_ARRIVAL });
  };
  const password = useAsyncAction((e: string, p: string) => auth.login(e, p), {
    success: land,
    failure: (err) => onRefused(refusalOf(err)),
  });
  const passkey = useAsyncAction(() => auth.loginWithPasskey(), {
    success: land,
    failure: (err) => onRefused(passkeyRefusal(err)),
  });
  return { password, passkey, land, busy: password.pending || passkey.pending, forInvite: isInvitePath(from.path) && from.asked };
}

function isInvitePath(path: string): boolean {
  return path.startsWith("/j/") || path.startsWith("/invites/");
}

export default function LoginPage() {
  const auth = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  /** The API's answer, held only for the life of the refusal on screen — never this browser's. */
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ending = useCapturedEnding();
  const signIn = useSignIn(setRefusal, ending);
  const signedOut = useSignedOutNotice(ending);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (signIn.busy) return;
    const found = validate(email, password);
    setErrors(found);
    if (found.email || found.password) {
      setRefusal(null);
      (found.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setRefusal(null);
    void signIn.password.run(email, password);
  };

  const needEmail = () => {
    setErrors({ email: LOGIN.resendNeedsEmail });
    emailRef.current?.focus();
  };

  const start = (action: { run: () => Promise<unknown> }) => {
    if (signIn.busy) return;
    setRefusal(null);
    void action.run();
  };

  return (
    // `my-auto` centres the card inside the headerless frame — sign-in is short enough to centre.
    <AuthShell
      className="my-auto"
      subline={AUTH_SUBLINE.signIn}
      title={LOGIN.title}
      footer={<>{LOGIN.newHere}{" "}<TextLink to="/register" className="py-3">{LOGIN.register}</TextLink></>}
    >
      <div className="flex flex-col gap-5">
        {signIn.forInvite ? <p className="text-base font-semibold text-text-primary">{LOGIN.inviteNotice}</p> : null}
        {auth.sessionExpired && !refusal ? <Alert tone="warning" live="polite">{LOGIN.sessionEnded}</Alert> : null}
        {signedOut && !refusal ? <Alert tone="success" live="polite">{signedOut}</Alert> : null}
        {isPasskeySupported() ? (
          <>
            {/* The fastest way in, so it is drawn as a real control at the top — it used to be
                a bare 56px circle with an 11px caption, and read as decoration. */}
            <Button
              type="button" variant="secondary" block pending={signIn.passkey.pending}
              onClick={() => start(signIn.passkey)} icon={<Fingerprint weight="bold" />}
            >
              {LOGIN.passkey}
            </Button>
            <AuthDivider>{LOGIN.or}</AuthDivider>
          </>
        ) : null}
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field>
            <FieldLabel>{LOGIN.email}</FieldLabel>
            <Input
              ref={emailRef} type="email" required autoComplete="email" inputMode="email"
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
            <FieldError>{errors.email}</FieldError>
          </Field>
          <Field>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <FieldLabel>{LOGIN.password}</FieldLabel>
              {/* A link at rest, not only on hover: it was caption-slate once, and the control
                  that helps a member who cannot get in was the one that did not look like one.
                  R4 (V4-1): the 44px target overhangs its line by what the line lacks (`lh`), not
                  by a fixed rem — at 200 % text `-my-3` pulled the field 24px up under the link. */}
              <TextLink to="/forgot-password" className="inline-flex min-h-touch items-center text-sm" style={FORGOT_OVERHANG}>{LOGIN.forgot}</TextLink>
            </div>
            <PasswordInput
              ref={passwordRef} required autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
            <FieldError>{errors.password}</FieldError>
          </Field>
          {refusal ? (
            <div className="flex flex-col gap-3">
              {/* A left rule and a mark rather than a bare red sentence: a refusal that looks like
                  body copy is one a member skims past and then presses the button again. */}
              <Alert>{refusal.message}</Alert>
              {refusal.contact ? <RefusalContact contact={refusal.contact} /> : null}
              {refusal.offerResend ? <ResendConfirmation email={email} onNeedEmail={needEmail} /> : null}
            </div>
          ) : null}
          <Button type="submit" block pending={signIn.password.pending}>{LOGIN.submit}</Button>
        </form>
        {import.meta.env.DEV ? <DevShortcut onLanded={signIn.land} onRefused={setRefusal} /> : null}
      </div>
    </AuthShell>
  );
}
