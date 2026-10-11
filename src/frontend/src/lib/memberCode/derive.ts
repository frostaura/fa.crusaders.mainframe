import { clubDayOf, STEP_MS } from "./clubDay";
import { hmac, hotp, importHmacKey, type HmacKey } from "./hotp";
import { encodeToken } from "./token";

/**
 * Member secret → the token for a step (`docs/specs/member-code.md` §3.4–§3.8, §10 "Compute").
 *
 * <pre>
 *   T     = floor(now / 30 000)
 *   ON    = HOTP(S, T, 8)
 *   day   = the club day of T in the club's zone
 *   K_day = first 12 bytes of HMAC(S, "crusaders/kday/v1|" + day)   — imported non-extractable
 *   OFF   = HOTP(K_day, T, 6)
 *   token = "1" + REF + ON + OFF
 * </pre>
 */

export const KDAY_LABEL_PREFIX = "crusaders/kday/v1|";
export const KDAY_BYTES = 12;

export function stepAt(unixMs: number): number {
  return Math.floor(unixMs / STEP_MS);
}

/**
 * K_day for one club day, as a non-extractable key.
 *
 * <p>
 * The 32-byte tag it is cut from exists as bytes for the length of this function and no
 * longer; the 12 that matter are imported and the array is zeroed. JavaScript cannot promise
 * the engine kept no copy, but nothing this code owns does.
 * </p>
 */
export async function deriveDayKey(secret: HmacKey, clubDay: string): Promise<HmacKey> {
  const tag = await hmac(secret, new TextEncoder().encode(KDAY_LABEL_PREFIX + clubDay));
  const raw = tag.slice(0, KDAY_BYTES);
  try {
    return await importHmacKey(raw);
  } finally {
    raw.fill(0);
    tag.fill(0);
  }
}

export type MemberCodeAt = {
  token: string;
  step: number;
  clubDay: string;
  on: string;
  off: string;
};

/**
 * Remembers each club day's key for the member it was derived for, so a code every thirty
 * seconds is one HMAC for ON and one for OFF rather than three. Keyed by the secret's handle,
 * so a re-enrolment (a new key) can never be answered from the old member's day keys.
 */
export class DayKeyCache {
  private owner: HmacKey | null = null;
  private days = new Map<string, Promise<HmacKey>>();

  get(secret: HmacKey, clubDay: string): Promise<HmacKey> {
    if (this.owner !== secret) {
      this.owner = secret;
      this.days = new Map();
    }
    let key = this.days.get(clubDay);
    if (!key) {
      key = deriveDayKey(secret, clubDay);
      // A day is 2 880 steps; nobody holds a page open across three of them, and a map that
      // only grows is a leak however slowly it grows.
      if (this.days.size >= 2) this.days.clear();
      this.days.set(clubDay, key);
      key.catch(() => this.days.delete(clubDay));
    }
    return key;
  }
}

/** The whole token at one step. Pure apart from the WebCrypto calls; no clock is read here. */
export async function memberCodeAt(
  secret: HmacKey,
  ref: string,
  tz: string,
  step: number,
  cache?: DayKeyCache,
): Promise<MemberCodeAt> {
  const clubDay = clubDayOf(step, tz);
  const dayKey = cache ? await cache.get(secret, clubDay) : await deriveDayKey(secret, clubDay);
  const [on, off] = await Promise.all([hotp(secret, step, 8), hotp(dayKey, step, 6)]);
  return { token: encodeToken(ref, on, off), step, clubDay, on, off };
}
