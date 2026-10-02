import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P13 §1.3.10 — "minutes, not credits", as a source scan.
 *
 * <p>
 * The club sells court TIME; a member never holds "credits" (Dean, 2026-10-01). Any `credit` left
 * in the console's CODE — a key, a call, a label, a string a member or an admin reads — is the old
 * unit leaking back. Comments are prose and are not scanned; tests are not scanned (several assert
 * the word's ABSENCE). What may stay is exactly the contract's §2.5 allow-list, below, each for a
 * stated reason. A new hit fails here: say it in minutes, or argue it onto §2.5 first.
 * </p>
 */
const ALLOWED: ReadonlyArray<readonly [token: RegExp, why: string]> = [
  [/\bcredit\.(?:adjusted|topped_up)\b/g, "stored change-record / audit action codes (append-only tables); only their words changed"],
  [/(["'])credit\1/g, "the change-record AREA code `credit`, stored on every old row"],
  [/^\s*credit(?=: ")/gm, "the same area code as a key of the area-to-words table"],
  [/\bCreditCard(?:Icon)?\b/g, "the payment-card glyph — a card, not a unit"],
  [/\/api\/v1\/credit\/topup\/callback\b/g, "PayFast's ITN notify_url, an external contract"],
  [/\b(?:balance|balance_before|balance_after|amount|spendable|collected|total_refunded|total_penalty)_credits\b/g,
    "change-record JSON keys on OLD rows, labelled so immutable history still reads in words"],
  [/\b(?:flat_slice_price_credits|slice_price_credits|credits_per_zar(?:_regular|_league)?)\b/g,
    "retired settings / group keys: bound and ignored by the server, and named on old change-record rows"],
];

const SRC = __dirname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "test" ? [] : sources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/** Code without comments — prose about the old unit is not the old unit. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function hits(): string[] {
  return sources(SRC).flatMap((file) => {
    let code = codeOf(file);
    for (const [token] of ALLOWED) code = code.replace(token, "");
    return code.split("\n").flatMap((line, i) =>
      /credit/i.test(line) ? [`${relative(SRC, file).split(sep).join("/")}:${i + 1}: ${line.trim()}`] : []);
  });
}

describe("minutes, not credits (P13 source scan)", () => {
  it("no code in the console says credit outside the §2.5 allow-list", () => {
    expect(hits()).toEqual([]);
  });

  it("the old credit formatters are gone for good", () => {
    const utils = readFileSync(join(SRC, "lib", "utils.ts"), "utf8");
    expect(utils).not.toMatch(/\bformat(?:Signed)?Credits\b/);
  });
});
