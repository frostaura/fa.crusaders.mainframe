import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clubDayOf, clubDayRange } from "./clubDay";
import { deriveDayKey, memberCodeAt, stepAt } from "./derive";
import { fromHex, hmac, hotp, importHmacKey, subtle, toHex } from "./hotp";
import { decodeRef, encodeRef, encodeToken, parseToken } from "./token";

/**
 * The phone against the contract corpus — `src/contracts/device-protocol/membercode/`, generated
 * by `src/iot/tools/membercode_vectors.py` from Python's own `hmac`, `hashlib` and `zoneinfo`, so
 * the phone is checked against an implementation that is not itself.
 *
 * <p>
 * <b>Executed equals declared, per section, and it fails loud.</b> `manifest.json` names every file
 * this reader must run (`read_by` contains `vitest`) and how many cases each section holds. Each
 * `describe` below counts what it actually executed and compares it with the manifest — so a case
 * added to the generator turns this suite red until it runs here too, and a file the manifest
 * starts naming for vitest turns it red until somebody reads it. A floor on the absolute counts
 * guards the other direction: an emptied corpus is not a passing one.
 * </p>
 */

const CORPUS = resolve(__dirname, "../../../../contracts/device-protocol/membercode");

type Manifest = { files: Record<string, { read_by: string[]; case_count: Record<string, number> }> };

function load<T>(file: string): T {
  return JSON.parse(readFileSync(join(CORPUS, file), "utf8")) as T;
}

const manifest = load<Manifest>("manifest.json");

/** What this suite executes, by file and section — compared with the manifest at the end. */
const executed: Record<string, Record<string, number>> = {};
function ran(file: string, section: string): void {
  executed[file] ??= {};
  executed[file][section] = (executed[file][section] ?? 0) + 1;
}

/**
 * The fewest cases each section may declare. Today's corpus is well above every one; these exist
 * so a generator bug that emits `[]` cannot make the phone's crypto "pass" by checking nothing.
 */
const FLOOR: Record<string, Record<string, number>> = {
  "sha256.json": { cases: 10 },
  "hmac.json": { cases: 9 },
  "totp.json": { cases: 18 },
  "derivation.json": { cases: 8 },
  "clubday.json": { cases: 6 },
  "token.json": { encode: 9, decode: 18 },
};

const key = (hex: string) => importHmacKey(fromHex(hex));

describe("membercode corpus — sha256.json", () => {
  type Case = { id: string; message_hex: string; repeat: number; digest_hex: string };
  const { cases } = load<{ cases: Case[] }>("sha256.json");
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const one = fromHex(c.message_hex);
    const message = new Uint8Array(one.length * c.repeat);
    for (let i = 0; i < c.repeat; i++) message.set(one, i * one.length);
    const digest = new Uint8Array(await subtle().digest("SHA-256", message.buffer.slice(0) as ArrayBuffer));
    expect(toHex(digest)).toBe(c.digest_hex);
    ran("sha256.json", "cases");
  });
});

describe("membercode corpus — hmac.json", () => {
  type Case = { id: string; key_hex: string; data_hex: string; mac_hex: string; truncate_bytes?: number };
  const { cases } = load<{ cases: Case[] }>("hmac.json");
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const mac = await hmac(await key(c.key_hex), fromHex(c.data_hex));
    expect(toHex(mac.slice(0, c.truncate_bytes ?? mac.length))).toBe(c.mac_hex);
    ran("hmac.json", "cases");
  });
});

describe("membercode corpus — totp.json", () => {
  type Case = { id: string; key_hex: string; unix: number; step: number; digits: number; code: string };
  const { cases } = load<{ cases: Case[] }>("totp.json");
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    expect(stepAt(c.unix * 1000)).toBe(c.step);
    expect(await hotp(await key(c.key_hex), c.step, c.digits)).toBe(c.code);
    ran("totp.json", "cases");
  });
});

describe("membercode corpus — clubday.json", () => {
  type Case = {
    id: string; tz: string; unix: number; step: number; club_day: string;
    day_first_step: number; day_end_step: number; day_steps: number;
  };
  const { cases } = load<{ cases: Case[] }>("clubday.json");
  it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(stepAt(c.unix * 1000)).toBe(c.step);
    expect(clubDayOf(c.step, c.tz)).toBe(c.club_day);
    const range = clubDayRange(c.step, c.tz);
    expect(range).toEqual({ first: c.day_first_step, end: c.day_end_step });
    expect(range.end - range.first).toBe(c.day_steps);
    ran("clubday.json", "cases");
  });
});

describe("membercode corpus — derivation.json (from S onwards)", () => {
  type Step = {
    label: string; unix: number; step: number; club_day: string; kday_hex: string; kday_b64url: string;
    on: string; off: string; token: string;
  };
  type Case = { id: string; member_secret_hex: string; ref: string; ref_value: number; tz: string; steps: Step[] };
  const corpus = load<{ kday_label_prefix_ascii: string; cases: Case[] }>("derivation.json");

  it("uses the label prefix the corpus was generated with", () => {
    // `derive.ts` hard-codes it; a generator that changed it must turn this red, not the codes.
    expect(corpus.kday_label_prefix_ascii).toBe("crusaders/kday/v1|");
  });

  it.each(corpus.cases.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    // S is imported exactly as the phone imports it: non-extractable, sign only. The HKDF step
    // above it (master key → S) is server-only and is not the phone's to check — `hkdf.json` is
    // not read by vitest, per the manifest.
    const secret = await key(c.member_secret_hex);
    expect((secret as CryptoKey).extractable).toBe(false);
    expect(encodeRef(c.ref_value)).toBe(c.ref);
    for (const s of c.steps) {
      expect(stepAt(s.unix * 1000), s.label).toBe(s.step);
      expect(clubDayOf(s.step, c.tz), s.label).toBe(s.club_day);
      // K_day itself is non-extractable on the phone, so its BYTES are checked through the same
      // HMAC with an extractable twin — and its behaviour through OFF with the real one.
      const tag = await hmac(secret, new TextEncoder().encode(corpus.kday_label_prefix_ascii + s.club_day));
      expect(toHex(tag.slice(0, 12)), s.label).toBe(s.kday_hex);
      expect(btoa(String.fromCharCode(...tag.slice(0, 12))).replace(/\+/g, "-").replace(/\//g, "_"), s.label).toBe(s.kday_b64url);
      const dayKey = await deriveDayKey(secret, s.club_day);
      expect((dayKey as CryptoKey).extractable, s.label).toBe(false);
      expect(await hotp(dayKey, s.step, 6), s.label).toBe(s.off);
      const code = await memberCodeAt(secret, c.ref, c.tz, s.step);
      expect({ on: code.on, off: code.off, token: code.token, clubDay: code.clubDay }, s.label)
        .toEqual({ on: s.on, off: s.off, token: s.token, clubDay: s.club_day });
    }
    ran("derivation.json", "cases");
  });
});

describe("membercode corpus — token.json", () => {
  type Encode = { id: string; ref_value: number; ref: string; on: string; off: string; token: string };
  type Decode = {
    id: string; input: string; ok: boolean; ref?: string; ref_value?: number; on?: string; off?: string; why?: string;
  };
  const corpus = load<{ token_len: number; encode: Encode[]; decode: Decode[] }>("token.json");

  it("is 19 characters", () => {
    expect(corpus.token_len).toBe(19);
  });

  it.each(corpus.encode.map((c) => [c.id, c] as const))("encode %s", (_id, c) => {
    expect(encodeRef(c.ref_value)).toBe(c.ref);
    expect(encodeToken(c.ref, c.on, c.off)).toBe(c.token);
    ran("token.json", "encode");
  });

  it.each(corpus.decode.map((c) => [c.id, c] as const))("decode %s", (_id, c) => {
    const parsed = parseToken(c.input);
    if (c.ok) {
      expect(parsed).toEqual({ ok: true, ref: c.ref, refValue: c.ref_value, on: c.on, off: c.off });
      expect(decodeRef(c.input.slice(1, 5))).toBe(c.ref_value);
    } else {
      expect(parsed).toEqual({ ok: false, why: c.why });
    }
    ran("token.json", "decode");
  });
});

describe("membercode corpus — the manifest", () => {
  const mine = Object.entries(manifest.files).filter(([, f]) => f.read_by.includes("vitest"));

  it("names for vitest exactly the files this suite reads", () => {
    expect(mine.map(([file]) => file).sort()).toEqual(Object.keys(FLOOR).sort());
  });

  it("declares at least the floor in every section", () => {
    for (const [file, f] of mine) {
      for (const [section, count] of Object.entries(FLOOR[file] ?? {})) {
        expect(f.case_count[section], `${file} ${section}`).toBeGreaterThanOrEqual(count);
      }
    }
  });

  // Last in the file, and `describe` blocks run in order: every vector above has run by now.
  it("executed every declared case of every file it reads — executed equals declared", () => {
    const declared = Object.fromEntries(mine.map(([file, f]) => [file, f.case_count]));
    expect(executed).toEqual(declared);
  });
});
