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
 *
 * <p>
 * <b>The one exception is a page with no WebCrypto at all.</b> Browsers expose `crypto.subtle`
 * only in a secure context (`https://` or `localhost`), and the club's stack on its LAN is plain
 * `http://<server IP>`. There the key is a {@link SoftHmacKey} — the bytes, frozen, signed with by
 * `sha256.ts` — because a phone that cannot make a code at all is worse than one whose key is
 * readable by the page. Production is https and never takes this path.
 * </p>
 */

import { hmacSha256 } from "./sha256";

/** WebCrypto's `SubtleCrypto`, or a loud failure. Only for callers that need WebCrypto itself. */
export function subtle(): SubtleCrypto {
  const s = maybeSubtle();
  if (!s) throw new Error("This browser has no WebCrypto (crypto.subtle), so it cannot make a member code.");
  return s;
}

/** WebCrypto when the page is in a secure context; null on a plain-http origin. */
function maybeSubtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

/** The fallback key on a page with no WebCrypto: the raw bytes, which only `hmac` reads. */
export type SoftHmacKey = { readonly kind: "soft-hmac-sha256"; readonly bytes: Uint8Array };

/** An HMAC-SHA-256 signing key: a non-extractable WebCrypto key, or the no-WebCrypto fallback. */
export type HmacKey = CryptoKey | SoftHmacKey;

/**
 * Realm-blind: a record read back from IndexedDB is a structured clone, and a clone made in another
 * realm (jsdom's under vitest, a worker's) holds a `Uint8Array` that fails `instanceof` here.
 */
export function isSoftHmacKey(key: unknown): key is SoftHmacKey {
  const k = key as Partial<SoftHmacKey> | null;
  return !!k && typeof k === "object" && k.kind === "soft-hmac-sha256"
    && ArrayBuffer.isView(k.bytes) && Object.prototype.toString.call(k.bytes) === "[object Uint8Array]";
}

/** Is `value` a key `hmac` can sign with — what a stored record must hold to be used. */
export function isHmacKey(value: unknown): value is HmacKey {
  return isSoftHmacKey(value) || (typeof CryptoKey !== "undefined" && value instanceof CryptoKey);
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

/**
 * Imports raw bytes as an HMAC-SHA-256 signing key. Non-extractable unless a test says otherwise.
 *
 * <p>
 * Without WebCrypto the bytes are COPIED into a frozen {@link SoftHmacKey}, so the caller's
 * zeroing of its own array still leaves the key intact.
 * </p>
 */
export async function importHmacKey(raw: Uint8Array, extractable = false): Promise<HmacKey> {
  const s = maybeSubtle();
  if (!s) return Object.freeze({ kind: "soft-hmac-sha256", bytes: raw.slice() }) as SoftHmacKey;
  return s.importKey("raw", buffer(raw), { name: "HMAC", hash: "SHA-256" }, extractable, ["sign"]);
}

/** HMAC-SHA-256 of `data` under `key` — the full 32-byte tag. */
export async function hmac(key: HmacKey, data: Uint8Array): Promise<Uint8Array> {
  if (isSoftHmacKey(key)) return hmacSha256(key.bytes, data);
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
export async function hotp(key: HmacKey, step: number, digits: number): Promise<string> {
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
