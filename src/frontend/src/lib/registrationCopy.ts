/**
 * Every sentence a person reads between deciding to join the club and signing in for the
 * first time — the form's own refusals, the API's, the wait, and the two link states.
 *
 * <p>
 * <b>Why a module.</b> The journey is four screens — `Register`, the inbox step,
 * `VerifyEmail`, `Login` — and an applicant who stalls on any one of them has nobody to
 * ask: they are, by definition, not a member yet, so every surface that carries the club's
 * phone number is behind the door they cannot open. Holding the words in one file is what
 * makes it possible to read the journey as a journey rather than as four files, and it is
 * what lets a test assert that no sentence sends somebody to a dead end. The house rule
 * (copy in `lib/*Copy.ts`) is the same rule for the same reason.
 * </p>
 *
 * <p>
 * <b>Second person, one instruction per sentence, no "simply" and no "just".</b> The club's
 * membership skews older and the product's own goal note says so; a sentence that assumes
 * the reader knows what a "verification token" is has already lost them.
 * </p>
 */

/** The form itself — headings, labels, help and the form's own refusals. */
export const REGISTER = {
  subline: "Apply for a member account. It takes a minute.",
  title: "Join the club",
  fullName: "Full name",
  email: "Email",
  membershipNumber: "Membership number",
  membershipHint: "As issued by the club — it's on your membership card.",
  password: "Password",
  passwordHint: "At least 8 characters.",
  submit: "Submit application",
  haveAccount: "Already have an account?",
  signIn: "Sign in",
  submittedSubline: "Your application is in.",
  startAgain: "Start a new application",
  verifySubline: "Confirming your email address.",
} as const;

/** What the form says on a field before it sends anything. The API's own versions are below. */
export const REGISTER_FIELD = {
  fullName: "Enter your full name as the club knows it.",
  email: "Enter your email address.",
  emailFormat: "Enter an email address like name@example.com.",
  membershipNumber: "Enter your membership number.",
  password: "Choose a password.",
  passwordShort: "Your password must be at least 8 characters.",
} as const;

/**
 * The API's refusal codes, as sentences.
 *
 * <p>
 * This screen used to map by status alone: every 400 became "password must be at least 8
 * characters", so a member who left their name blank was told to fix a password that was
 * already fine. And a membership number that was already taken produced an unhandled 500 and
 * "Registration failed. Try again." — advice that could never work, on the most ordinary human
 * mistake there is: typing a digit of someone else's club number.
 * </p>
 */
export const REGISTER_MESSAGES: Record<string, string> = {
  missing_fields: "Please fill in every field — name, email, membership number and password.",
  password_too_short: "Your password must be at least 8 characters.",
  email_in_use: "An account with that email already exists. Sign in instead, or reset your password.",
  membership_number_in_use:
    "That membership number is already registered. Check the number on your card — if it's right, contact the club committee.",

  // The upload endpoint's own refusals. They were absent, and that absence is what made a
  // rejected photo read as a network fault: uploadPhoto throws before register() is ever
  // called, and every code it can produce fell through to the connection sentence.
  // preparePhoto now re-encodes to a small JPEG before the request, so reaching any of these
  // means something stranger than a big iPhone photo went wrong — they stay mapped because a
  // sentence naming the real cause is the entire point of this screen.
  unsupported_content_type:
    "The club's system wouldn't accept that image format. Try a different photo — a JPEG or PNG works.",
  file_too_large: "That photo is too large for the club's system, even after resizing. Try a different one.",
  file_missing: "The photo didn't reach the club's system. Pick it again and resubmit.",
  expected_multipart: "The photo didn't upload correctly. Pick it again and resubmit.",
};

/**
 * FM-4 — the application's reply went missing (a timeout, a dropped connection, the gateway saying
 * the club's system did not answer): it may have arrived. Said beside the failure, and — when the
 * next try is told the address is taken — instead of "an account with that email already exists".
 */
export const REGISTER_UNSURE = {
  mayHaveArrived: "It may have arrived anyway — check your email for a confirmation link before sending it again.",
  probablyArrived:
    "Your first try probably arrived: an application with this email is already in. Check your email for the confirmation link — if nothing came, use Forgot password on the sign-in page.",
} as const;

/**
 * <b>The sentence that could not be reached, and the bug it is the other half of.</b>
 *
 * <p>
 * `PhotoPicker` rendered `required` on a file input that is `sr-only` — one CSS pixel, clipped
 * to nothing, and still a live candidate for the browser's own constraint validation. Chrome
 * therefore refused to submit the form and had nowhere to draw its bubble, so an applicant
 * filled in four fields, pressed <b>Submit application</b>, and the page did not move, did not
 * scroll, said nothing and logged nothing. This sentence existed the whole time and was dead
 * code: `onSubmit` never fired.
 * </p>
 *
 * <p>
 * The `required` attribute is gone (`aria-required` says the same thing to a screen reader and
 * blocks nothing), the form does its own checking, and the message is shown <b>on the photo
 * field</b> rather than at the foot of the form — because the field is what has to change, and
 * on a 320 px phone the foot of the form is not where the member is looking.
 * </p>
 */
export const PHOTO_REQUIRED = "Please add a photo of yourself — the club uses it to recognise you on court, "
  + "so an application can't be sent without one.";

/**
 * Distinct from having no photo at all. Telling somebody who is watching their photo being
 * prepared that they have not chosen one is simply false.
 */
export const PHOTO_PREPARING = "Your photo is still being prepared — give it a second, then submit again.";

/** The three steps, on the screen an applicant lands on the moment the application is in. */
export const INBOX_HEADING = "Check your inbox";
export const INBOX_STEPS = [
  "We've emailed you a link — open it to confirm your address.",
  "The club checks your membership number against its records.",
  "You'll get a second email once you're approved, and then you can book.",
] as const;

/**
 * <b>What the wait actually costs, said before anybody has to ask.</b>
 *
 * <p>
 * "An admin reviews your application" left an applicant with no idea whether anything more was
 * required of them, or how long to wait before assuming it had failed. The three steps above
 * fixed the first half. This is the second: a person who knows a human has to look at something
 * waits; a person who does not know that presses the button again, registers a second time with
 * a different email, and arrives at the desk convinced the app is broken.
 * </p>
 */
export const INBOX_PATIENCE = "Approving a new member is somebody at the club opening the list and checking it, "
  + "so it usually takes a day or two. Nothing else is needed from you in the meantime.";

// --- confirming the address --------------------------------------------------------

export const VERIFY_WORKING = "Confirming your email address…";
export const VERIFY_OK_HEADING = "Email confirmed";
export const VERIFY_OK_BODY = "That's your address confirmed. Somebody at the club now checks your membership "
  + "number against their records and approves your account — you'll get a second email when they have.";

/**
 * Go-live BM-11 — an admin may approve before the address is confirmed, and the page told that
 * member to wait for an approval that had already happened. When the API says so, it says the
 * account is ready; when the API does not say, it claims neither.
 */
export const VERIFY_OK_BODY_APPROVED = "That's your address confirmed, and the club has already approved your account. "
  + "You can sign in now.";
export const VERIFY_OK_BODY_UNKNOWN = "That's your address confirmed. If the club hasn't approved your account yet, "
  + "somebody there checks your membership number against their records — you'll get an email when they have.";

export function verifyOkBody(approved: boolean | undefined): string {
  if (approved === true) return VERIFY_OK_BODY_APPROVED;
  if (approved === false) return VERIFY_OK_BODY;
  return VERIFY_OK_BODY_UNKNOWN;
}

/**
 * <b>"Try registering again" was the dead end.</b>
 *
 * <p>
 * The failure arm could not tell an expired link from one that had already been used, and it
 * told both to re-register. The already-used case is the ordinary one — a person opens the email
 * on their phone, then opens it again on the laptop, or taps it twice — and by then their address
 * is confirmed and the account exists, so registering again is answered `email_in_use` and the
 * screen that said "try registering again" has sent them to a refusal. Both halves are now
 * named, and the first thing offered is the thing that works if the link was merely spent.
 * </p>
 */
export const VERIFY_FAIL_HEADING = "That link didn't work";
export const VERIFY_FAIL_BODY = "Confirmation links can only be used once, and they expire. If you've already "
  + "opened this one, your address is confirmed and there's nothing more to do here — try signing in. If signing "
  + "in says your address still isn't confirmed, ask for a fresh link from that screen.";
export const VERIFY_FAIL_PRIMARY = "Go to sign in";

/**
 * The confirmation call was RATE-LIMITED (429) — a different event from a bad link, and the
 * page must not say the link is broken. The limiter answers before the token is looked at, so
 * the link is untouched and still good: the one thing to do is wait and open it again. Found in
 * the P10 walk, where a burst of opens read "That link didn't work" on a perfectly good link.
 */
export const VERIFY_LIMITED_HEADING = "Too many tries — wait a minute and open the link again";
export const VERIFY_LIMITED_BODY = "Your link is still good: nothing was used up. The club's system is slowing down "
  + "repeated attempts, so give it a minute and then try again.";
export const VERIFY_LIMITED_RETRY = "Try again";
export const VERIFY_BACK_TO_SIGN_IN = "Back to sign in";

// --- the wait, as the sign-in screen states it ---------------------------------------

/**
 * <b>The pending sentence, with the one fact it was missing.</b>
 *
 * <p>
 * "An admin will email you once they've reviewed it" is true and leaves an applicant with no
 * idea whether to wait an hour or a fortnight, which is how somebody decides the application
 * was lost. The refusal body already carries the club's own phone number and address (see
 * `Login`'s `refusalContact`), so the screen can say how long it usually takes AND give them
 * somebody to ask — which is the difference between a wait and a wall.
 * </p>
 */
export const PENDING_APPROVAL = "Your account is registered and waiting for the club to approve it. "
  + "That is somebody checking your membership number by hand, so it usually takes a day or two. "
  + "You'll get an email the moment it's done.";

// --- the photo field ------------------------------------------------------------------

/** `PhotoPicker`'s own words. The label is what the input is named by, and what tests query. */
export const PHOTO_PICKER = {
  label: "Photo of yourself",
  hint: "So other players can recognise you on court. Your face, clearly lit.",
  choose: "Take or choose a photo",
  drop: "or drop an image here",
  preparing: "Preparing your photo…",
  ready: "Photo ready",
  previewAlt: "The photo you chose",
  replace: "Choose a different photo",
  remove: "Remove this photo",
  failed: "We couldn't prepare that photo. Try a different one.",
} as const;
