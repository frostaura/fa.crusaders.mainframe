/**
 * HMAC-SHA-256 and HOTP over WebCrypto — the two primitives the single rotating member code
 * (D1, `docs/specs/member-code.md` §3) is built from.
 *
 * <p>
 * <b>Nothing here ever holds raw key bytes for longer than one call.</b> A key arrives as bytes
 * exactly once — at enrolment, or as the first 12 bytes of an HMAC when a day key is derived —
 * and is imported as a NON-extractable `CryptoKey` on the spot. After that the only thing the
 * page can do with it is `sign`: it cannot be read back, logged, serialised or sent anywhere,
 * which is the whole reason the member secret S is held as a key handle and not as a string.
 * </p>
 */

/** WebCrypto's `SubtleCrypto`, or a loud failure — a phone without it cannot make a code at all. */
export function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("This browser has no WebCrypto (crypto.subtle), so it cannot make a member code.");
  return s;
}

/**
 * A copy of `bytes` in a fresh `ArrayBuffer`.
 *
 * <p>
 * WebCrypto wants a `BufferSource`, and a `Uint8Array` built in another realm (jsdom's, under
 * vitest) or one viewing part of a larger buffer is where "not a BufferSource" and silently
 * wrong key material come from. A copy of exactly the bytes meant is never wrong.
 * </p>
 */
function buffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Imports raw bytes as an HMAC-SHA-256 signing key. Non-extractable unless a test says otherwise. */
export function importHmacKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return subtle().importKey("raw", buffer(raw), { name: "HMAC", hash: "SHA-256" }, extractable, ["sign"]);
}

/** HMAC-SHA-256 of `data` under `key` — the full 32-byte tag. */
export async function hmac(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign("HMAC", key, buffer(data)));
}

/**
 * The step as the 8-byte big-endian counter HOTP signs (RFC 4226 §5.1).
 *
 * <p>
 * Split into two 32-bit halves by division rather than shifted, because a JavaScript `>>` is a
 * 32-bit operation and a step past 2^31 — every step since 1990 at 30 seconds is well under
 * that, but the code should not care — would come out negative.
 * </p>
 */
export function counterBytes(step: number): Uint8Array {
  if (!Number.isSafeInteger(step) || step < 0) throw new Error(`not a step: ${step}`);
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(step / 2 ** 32));
  view.setUint32(4, step % 2 ** 32);
  return out;
}

/**
 * RFC 4226 §5.3 dynamic truncation over a 32-byte SHA-256 digest: the low nibble of the LAST
 * byte picks four bytes, whose top bit is masked off.
 */
export function truncate(digest: Uint8Array, digits: number): string {
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) * 2 ** 24)
    + (digest[offset + 1] << 16)
    + (digest[offset + 2] << 8)
    + digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** HOTP(key, step, digits) with HMAC-SHA-256 — which is TOTP's SHA-256 mode when `step = floor(t / 30)`. */
export async function hotp(key: CryptoKey, step: number, digits: number): Promise<string> {
  return truncate(await hmac(key, counterBytes(step)), digits);
}

/** Lower-case hex, for tests and for nothing that leaves this device. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("not hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Unpadded base64url (RFC 4648 §5) to bytes — the enrol response's `secret`.
 *
 * <p>
 * Strict: any character outside the url-safe alphabet, padding, or a length that cannot be
 * whole bytes refuses, because a secret that decodes "mostly" is a member whose every code
 * the server rejects.
 * </p>
 */
export function fromBase64Url(text: string): Uint8Array {
  if (/[^A-Za-z0-9_-]/.test(text) || text.length % 4 === 1) throw new Error("not unpadded base64url");
  const std = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
