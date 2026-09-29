/**
 * The words on `/profile` (P3). Tests query by these constants, so a copy change is one edit
 * here rather than a hunt through assertions.
 */

export const PROFILE_TITLE = "Profile";
export const PROFILE_DESCRIPTION
  = "Your photo and name are what other players see on the booking grid and on every booking.";

export const DETAILS_TITLE = "Your details";

/** The limits `PUT /api/v1/me/profile` enforces on a name — stated here, enforced here. */
export const NAME_MIN = 2;
export const NAME_MAX = 120;
export const NAME_LABEL = "Full name";
export const NAME_PLACEHOLDER = "As it appears on the schedule";
export const NAME_HINT = `At least ${NAME_MIN} characters. Shown to other players on the booking grid.`;
export const NAME_SAVE = "Save";
export const NAME_SAVED = "Name updated.";
export const NAME_INVALID = `Your name must be between ${NAME_MIN} and ${NAME_MAX} characters.`;

export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
/** The avatar's accessible name — it is a button that opens the file chooser. */
export const PHOTO_CHANGE_LABEL = "Change profile photo";
/** The visible button beside it: a phone has no hover, so the avatar alone never said "tap me". */
export const PHOTO_BUTTON = "Change photo";
export const PHOTO_HINT = "PNG, JPG, WEBP or GIF, up to 5 MB. Tap the photo, or drop an image on it.";
export const PHOTO_UPDATED = "Profile photo updated.";
export const PHOTO_BAD_TYPE = "That file isn't a PNG, JPG, WEBP or GIF — pick one of those.";
export const PHOTO_TOO_BIG = "That image is over 5 MB — pick a smaller one.";
export const PHOTO_UPLOADING = "Uploading your photo…";

export const PASSWORD_TITLE = "Password";
export const PASSWORD_DESCRIPTION
  = "Change the password you sign in with. We'll email you whenever it changes, so you'd know if somebody else did it.";
export const PASSWORD_OPEN = "Change password";

export const PASSKEYS_TITLE = "Passkeys";
export const PASSKEY_INTRO
  = "One-tap sign-in with your device's biometrics or a security key. Add as many as you like — phone, laptop, key.";
export const PASSKEY_UNSUPPORTED
  = "This browser doesn't support passkeys. Use a recent Chrome, Safari, Edge or Firefox on a device with biometrics or a security key.";
export const PASSKEY_EMPTY_TITLE = "No passkeys yet";
export const PASSKEY_EMPTY_HINT = "Add one below to sign in with a touch or a glance.";
export const PASSKEY_NAME_LABEL = "Name this passkey";
export const PASSKEY_NAME_PLACEHOLDER = "e.g. iPhone, MacBook, YubiKey";
export const PASSKEY_NAME_HINT = "So you can tell your devices apart later.";
export const PASSKEY_NAME_MISSING = "Give the passkey a name so you can tell your devices apart.";
export const PASSKEY_ADD = "Add passkey";
export const PASSKEY_ADDED = "Passkey added.";
export const PASSKEY_REMOVE = "Remove";
export const PASSKEY_REMOVED = "Passkey removed.";

/** The armed consequence on Remove — what stops working, said before the second press. */
export function passkeyRemoveConsequence(label: string): string {
  return `Remove “${label}”? You won't be able to sign in with it any more. Your password and other passkeys still work.`;
}

/** "Added 01 Sep 2026 · Last used 14 Sep · internal". */
export function passkeyMeta(created: string, lastUsed: string | null, transports: string | null): string {
  const used = lastUsed ? ` · Last used ${shortDate(lastUsed, false)}` : " · Never used";
  return `Added ${shortDate(created, true)}${used}${transports ? ` · ${transports}` : ""}`;
}

function shortDate(iso: string, withYear: boolean): string {
  return new Date(iso).toLocaleDateString("en-GB", withYear
    ? { day: "2-digit", month: "short", year: "numeric" }
    : { day: "2-digit", month: "short" });
}

/* Sign out everywhere (member-code §10) — every session ends, this one included. */
export const SIGN_OUT_EVERYWHERE_COPY = {
  title: "Signed-in devices",
  description:
    "Lost a phone, or left yourself signed in on somebody else's? Sign out everywhere ends every session you have — this one too.",
  open: "Sign out everywhere",
  confirmTitle: "Sign out on every device?",
  confirmBody:
    "Every phone, tablet and computer you're signed in on is signed out, this one included, and the member code on your phone stops working. Sign in again to carry on — you'll get a new code.",
  revokePasskeys: "Also remove my passkeys",
  revokePasskeysHint:
    "Turn this on if a device with one of your passkeys is lost — otherwise it could sign straight back in. Leave it off to keep signing in with a touch.",
  confirm: "Sign out everywhere",
  action: "sign you out everywhere",
  /** Shown on /login, where the member lands — this session is over the moment it answers. */
  done: (passkeysRevoked: boolean, passkeysRemoved: number) =>
    `You're signed out on every device. Sign in again to get a new member code.${passkeysNote(passkeysRevoked, passkeysRemoved)}`,
} as const;

function passkeysNote(revoked: boolean, removed: number): string {
  if (!revoked || removed === 0) return "";
  return removed === 1 ? " Your passkey was removed, so use your password." : ` Your ${removed} passkeys were removed, so use your password.`;
}
