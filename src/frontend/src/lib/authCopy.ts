import { PENDING_APPROVAL } from "./registrationCopy";

/**
 * Every sentence on the sign-in, password and welcome-link screens (`Login`, `ForgotPassword`,
 * `ResetPassword`, `ChangePassword`, `Welcome`) — the joining journey's own words stay in
 * `registrationCopy`, which this reuses rather than restates.
 *
 * <p>
 * The house rule (copy in `lib/*Copy.ts`, tests query by the constant) exists so a sentence is
 * changed in one place and a test pinned to it moves with it. The sentences themselves were
 * each written against a specific defect — a refusal that told a suspended member to wait, a
 * dead end after a spent link — and the notes beside them say which, so a later tidy does not
 * quietly reintroduce the mistake.
 * </p>
 */

/** What the auth band says under the club's name — one line on what the account is FOR. */
export const AUTH_SUBLINE = {
  signIn: "Court bookings, credits and your club account.",
  password: "Set a new password for your club account.",
  welcome: "Welcome to the club.",
} as const;

/** A form that refused to send, summarised just above its button, where the member is looking. The detail is on each field. */
export function checkFields(count: number): string {
  return count === 1
    ? "One thing needs fixing — it's marked above."
    : `${count} things need fixing — they're marked above.`;
}

/** The show/hide control inside every password field. */
export const PASSWORD_TOGGLE = { show: "Show password", hide: "Hide password" } as const;

export const FIELD_REQUIRED = {
  email: "Enter your email address.",
  emailFormat: "Enter an email address like name@example.com.",
  password: "Enter your password.",
} as const;

export const LOGIN = {
  title: "Sign in",
  submit: "Sign in",
  email: "Email",
  password: "Password",
  forgot: "Forgot password?",
  newHere: "New to the club?",
  register: "Register",
  passkey: "Sign in with a passkey",
  or: "or use your email",
  resend: "Resend the confirmation email",
  resent: "Sent. If that address is registered and still unconfirmed, a fresh link is on its way — it replaces any earlier one.",
  resendNeedsEmail: "Enter your email address above so we know where to send the link.",
  sessionEnded: "Your session ended, so we've signed you out. Sign in again to pick up where you left off.",
  /** R1 (lane F2) — arriving from an invite link: what signing in is FOR. */
  inviteNotice: "Sign in to answer your invite",
  contactHeading: "Contact the club",
} as const;

/**
 * The refusals, one per cause. A 403 is two different problems (an unconfirmed address, a
 * membership that is not active), and the membership one is three: all three used to share one
 * sentence — "isn't approved yet, an admin will email you" — which was false for two of them.
 */
export const LOGIN_REFUSAL = {
  network: "Couldn't reach the club. Check your connection and try again.",
  credentials: "Email or password is incorrect.",
  rateLimited: "Too many sign-in attempts. Wait a minute, then try again.",
  // Was a bare 403 mapped to "Your account isn't approved yet." — which told approved members
  // the wrong thing about the wrong thing, and left them nothing to do.
  unverified: "You haven't confirmed your email address yet. Check your inbox for the link we sent when you registered.",
  // "may" — this screen cannot know an email was sent, bounced or read; asserting it tells a
  // member who never got one that the club has already explained itself.
  suspended: "Your membership is suspended, so you can't sign in. The club may have emailed you the reason — speak to them to have it restored.",
  rejected: "Your application wasn't approved, so this account can't be used. The club may have emailed you the reason — contact them if you think it's a mistake.",
  pending: PENDING_APPROVAL,
  generic: "Sign in failed. Try again in a moment.",
  passkeyUnknown: "That passkey isn't recognised. Sign in with email and password, then add a passkey from your profile.",
  passkeyFailed: "Passkey sign-in failed. Try email and password.",
} as const;

export const FORGOT = {
  title: "Reset your password",
  lead: "Enter the email address you registered with and we'll send you a link to set a new password.",
  submit: "Send reset link",
  sentTitle: "Check your inbox",
  /** Deliberately does not say whether the address is registered — see ForgotPassword. */
  sent: (email: string) => `If ${email} belongs to an account, we've emailed a link to set a new password. It works once, and expires in an hour.`,
  nothingArrived: "Nothing arrived? Check spam, then ask the club committee — they can issue you a temporary password.",
  back: "Back to sign in",
  remembered: "Remembered it?",
  signIn: "Sign in",
} as const;

export const RESET = {
  title: "Choose a new password",
  lead: "This link works once, and only for an hour after it was sent.",
  newPassword: "New password",
  confirm: "Confirm new password",
  hint: "At least 8 characters.",
  submit: "Set new password",
  mismatch: "The two passwords don't match.",
  tooShort: "Your new password must be at least 8 characters.",
  enterNew: "Enter a new password.",
  enterConfirm: "Type the new password again.",
  incomplete: "This reset link is incomplete. Request a new one.",
  // One answer on purpose: the API answers 400 for expired, used and wrong alike, because
  // telling them apart would tell a guesser which tokens exist.
  spent: "This reset link has expired or has already been used. Request a new one.",
  rateLimited: "Too many attempts. Wait a minute, then try again.",
  doneTitle: "Password updated",
  done: "You can sign in with your new password now.",
  signIn: "Sign in",
  expired: "Link expired?",
  requestNew: "Request a new one",
} as const;

export const CHANGE_PASSWORD = {
  chosenTitle: "Change your password",
  forcedTitle: "Choose your own password",
  chosenLead: "You'll need your current password to set a new one.",
  /*
   * N-F10: deliberately does NOT say "an admin has reset your password" — the first person ever
   * to sign in to a club was created by ProductionBootstrap with must-change-password set, and
   * nobody reset anything. The one meaning the screen can rely on is that it is temporary.
   */
  forcedLead: "Your account is on a temporary password. Choose your own to carry on — the temporary one stops working the moment you do.",
  current: "Current password",
  temporary: "Temporary password",
  newPassword: "New password",
  newHint: "At least 8 characters, and different from your current one.",
  confirm: "Confirm new password",
  submit: "Change password",
  cancel: "Cancel",
  changed: "Password changed.",
  mismatch: "The two new passwords don't match.",
  enterCurrent: "Enter your current password.",
  enterNew: "Enter a new password.",
  noTemporary: "Haven't got the temporary password?",
  resetLink: "Email yourself a reset link",
  instead: "instead.",
  back: "Profile",
} as const;

/**
 * The API's refusal codes, as sentences. A member never sees a code, and never sees the same
 * sentence for two different mistakes.
 */
export const CHANGE_PASSWORD_MESSAGES: Record<string, string> = {
  current_password_incorrect: "That's not your current password. Try again.",
  password_unchanged: "Your new password has to be different from your current one.",
  password_too_short: "Your new password must be at least 8 characters.",
  missing_fields: "Fill in both your current and your new password.",
  no_password_set: "This account signs in with a passkey and has no password to change. Use “Forgot password?” on the sign-in screen to set one.",
};

export const WELCOME = {
  working: "Signing you in…",
  incomplete: "That sign-in link is incomplete — it may have been cut short on its way here.",
  // One code (`invalid_or_expired`) for both — the API cannot tell them apart, so neither can
  // the sentence. "Expired" alone sends a member to ask for a link when they need their password.
  spent: "This sign-in link has expired or has already been used — welcome links work once.",
  spentTitle: "That link has already been used",
  incompleteTitle: "That link is incomplete",
  reassure: "Your account is fine — only the link is spent. Sign in with your password, or have the club email you a link to set one.",
  signIn: "Sign in",
  resetLink: "Email me a reset link",
} as const;
