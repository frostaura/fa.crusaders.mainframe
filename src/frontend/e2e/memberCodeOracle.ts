import { createHmac } from "node:crypto";
import { MEMBER_CODE } from "./fixtures";

/**
 * An independent implementation of the member code (docs/specs/member-code.md §3.4–§3.8), on
 * Node's own HMAC — so a browser test can say whether the token on the phone's glass is the one
 * the club would compute, rather than only that it looks like one.
 */
function hotp(key: Buffer, step: number, digits: number): string {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step % 2 ** 32, 4);
  const d = createHmac("sha256", key).update(counter).digest();
  const o = d[d.length - 1] & 0x0f;
  const bin = ((d[o] & 0x7f) * 2 ** 24) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

function clubDay(step: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(step * 30_000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The fixture member's token at `step`. */
export function expectedToken(step: number): string {
  const s = Buffer.from(MEMBER_CODE.secretHex, "hex");
  const kday = createHmac("sha256", s).update(`crusaders/kday/v1|${clubDay(step, MEMBER_CODE.tz)}`).digest().subarray(0, 12);
  return `1${MEMBER_CODE.ref}${hotp(s, step, 8)}${hotp(kday, step, 6)}`;
}

/** The tokens for the steps either side of now — a page read a moment ago may be one step behind. */
export function tokensAroundNow(): string[] {
  const t = Math.floor(Date.now() / 30_000);
  return [t - 1, t, t + 1].map(expectedToken);
}
