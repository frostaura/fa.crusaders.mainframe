/**
 * The token and its REF (`docs/specs/member-code.md` §3.3, §3.8):
 * `"1" + REF(4 Crockford) + ON(8 digits) + OFF(6 digits)`, 19 characters.
 *
 * <p>
 * The phone only ever ENCODES — the server hands it a canonical REF and it prints what it
 * computes. The decoder is here because `token.json` is read by this suite too (executed must
 * equal declared), and because a phone that could not recognise its own output would be the
 * cheapest bug in the chain to leave uncaught.
 * </p>
 */

export const TOKEN_LEN = 19;
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 20-bit REF value as four canonical Crockford characters, most significant first. */
export function encodeRef(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value >= 2 ** 20) throw new Error(`not a REF value: ${value}`);
  let out = "";
  for (let shift = 15; shift >= 0; shift -= 5) out += CROCKFORD[(value >> shift) & 31];
  return out;
}

/** One REF character, normalised per §3.3 — ASCII only, case-folded, I/L→1, O→0 — or -1. */
function refDigit(ch: string): number {
  if (ch.length !== 1 || ch.charCodeAt(0) > 0x7f) return -1;
  const up = ch.toUpperCase();
  const mapped = up === "I" || up === "L" ? "1" : up === "O" ? "0" : up;
  return CROCKFORD.indexOf(mapped);
}

/** A REF string as its value, or null when it does not decode or is the reserved `0000`. */
export function decodeRef(text: string): number | null {
  const chars = Array.from(text);
  if (chars.length !== 4) return null;
  let value = 0;
  for (const ch of chars) {
    const d = refDigit(ch);
    if (d < 0) return null;
    value = value * 32 + d;
  }
  return value === 0 ? null : value;
}

/** Is `ref` a canonical, assignable REF — how the server must send one (§3.3)? */
export function isCanonicalRef(ref: string): boolean {
  const value = decodeRef(ref);
  return value !== null && encodeRef(value) === ref;
}

export function encodeToken(ref: string, on: string, off: string): string {
  if (!isCanonicalRef(ref)) throw new Error("not a canonical REF");
  if (!/^\d{8}$/.test(on) || !/^\d{6}$/.test(off)) throw new Error("ON is 8 digits and OFF is 6");
  return `1${ref}${on}${off}`;
}

export type ParsedToken =
  | { ok: true; ref: string; refValue: number; on: string; off: string }
  | { ok: false; why: "length" | "version" | "ref" | "digits" };

/** §3.8's parse, in its order: length (in characters), version, REF, digits. */
export function parseToken(input: string): ParsedToken {
  const chars = Array.from(input);
  if (chars.length !== TOKEN_LEN) return { ok: false, why: "length" };
  if (chars[0] !== "1") return { ok: false, why: "version" };
  const refValue = decodeRef(chars.slice(1, 5).join(""));
  if (refValue === null) return { ok: false, why: "ref" };
  const digits = chars.slice(5).join("");
  if (!/^[0-9]{14}$/.test(digits)) return { ok: false, why: "digits" };
  return { ok: true, ref: encodeRef(refValue), refValue, on: digits.slice(0, 8), off: digits.slice(8) };
}

/**
 * The token as a member reads it aloud at the desk: `118Y9 5600 8441 714 835`.
 *
 * <p>
 * Version and REF together (the part that never changes for this member), then ON in fours and
 * OFF in threes — no group longer than five, which is about what a person holds in their head
 * while looking from a phone to a keyboard. Display only: the QR and every accessible name
 * carry the unbroken token.
 * </p>
 */
export function groupToken(token: string): string[] {
  return [token.slice(0, 5), token.slice(5, 9), token.slice(9, 13), token.slice(13, 16), token.slice(16)];
}
