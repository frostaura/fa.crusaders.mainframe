import { Fragment } from "react";

/**
 * After an "@" and before each ".". Built from a string, not a literal: lizard's lexer reads the
 * literal's lookbehind as the start of something it never closes, and scored every function
 * below it as part of it (gotchas-gates).
 */
const EMAIL_BREAKS = new RegExp("(?<=@)|(?=\\.)");

/**
 * An address that may break after its "@" and before each "." (R3 V-14, R4 V4-9, R5 F5-3):
 * `break-all` split it mid-word over three lines at 1280, and with no break offered at all a long
 * verified address scrolled the Sign-in tab sideways at 390. With the break points offered, the
 * caller's `break-words` breaks mid-word only where one part alone is wider than its box.
 */
export function EmailWithBreaks({ email }: { email: string | null | undefined }) {
  if (!email) return null;
  return <>{email.split(EMAIL_BREAKS).map((part, i) => <Fragment key={i}>{i > 0 ? <wbr /> : null}{part}</Fragment>)}</>;
}
