/**
 * The name a passkey made here is saved under, so the list in Profile can tell devices apart.
 *
 * <p>
 * Profile asks the member to type one; the wizard does not, because a text field is the one
 * thing standing between somebody older and a Face ID prompt, and the name is only a label.
 * Guessed from the platform, and editable by removing and re-adding in Profile.
 * </p>
 */
export function passkeyLabelFor(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android phone";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  return "This device";
}
