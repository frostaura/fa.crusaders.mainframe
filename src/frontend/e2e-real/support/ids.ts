/**
 * Run-scoped identities for the real-stack suite.
 *
 * <p>
 * Every address is under `signup.review.test`. `.test` is reserved (RFC 2606) and can never
 * resolve, so even a stack misconfigured to relay through real SMTP cannot deliver to a person.
 * Nothing in this suite may use any other domain.
 * </p>
 */
// The time alone is not unique once projects run in parallel (desktop-play and mobile-play start
// their workers in the same millisecond and registered the same address); the worker's process
// id makes the run id per process.
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let counter = 0;

export const REVIEW_DOMAIN = "signup.review.test";

/** `walk+<run>-<n>@signup.review.test` — unique per call, grouped per run. */
export function uniqueEmail(prefix = "walk"): string {
  counter += 1;
  return `${prefix}+${RUN}-${counter}@${REVIEW_DOMAIN}`;
}

/** A membership number no seeded member and no earlier run holds. */
export function uniqueMembershipNumber(): string {
  counter += 1;
  return `W-${RUN}-${counter}`.toUpperCase();
}

/** A password the register form accepts (8+ characters). */
export function walkPassword(): string {
  return `Walk-${RUN}-pass!`;
}

/** A plausible person's name; PersonNames rejects digits-only and symbol soup. */
export function walkFullName(): string {
  counter += 1;
  return `Walker ${String.fromCharCode(65 + (counter % 26))}. Review`;
}

/** 32x32 solid PNG. PhotoPicker decodes and re-encodes it, so it must be a real image. */
const AVATAR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR42mPQiFpAU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAEgoiD3xiSqXAAAAAElFTkSuQmCC";

export function avatarFile(): { name: string; mimeType: string; buffer: Buffer } {
  return { name: "walker.png", mimeType: "image/png", buffer: Buffer.from(AVATAR_PNG_BASE64, "base64") };
}
