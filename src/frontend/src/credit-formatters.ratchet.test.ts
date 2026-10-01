import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * P13 — "minutes, not credits": the deprecated credit formatters, as a RATCHET.
 *
 * <p>
 * `formatCredits` / `formatSignedCredits` (`lib/utils.ts`) and `courtsCopy.formatCredits` print
 * "20.00 cr" — a decimal and a unit the club no longer has. They stay, `@deprecated`, until
 * phase 2 of P13 deletes them (`docs/specs/minutes-and-packages.md` §7.1, §10.3); every amount is
 * meant to come through `lib/minutes.ts` / `<Minutes>` instead. {@link ALLOW} names every
 * non-test source that still mentions either name, and the lane that owns it (§10.2). The test fails when:
 * </p>
 * <ul>
 *   <li>a file NOT on the list starts calling one — new debt;</li>
 *   <li>a listed file no longer does — it was migrated, so take it off the list (it only shrinks);</li>
 *   <li>a listed file no longer exists.</li>
 * </ul>
 *
 * <p>
 * `lib/utils.ts` is exempt: it is where the two are defined, and phase 2 deletes them there.
 * Comments do not count. To regenerate after a sweep:
 * `CREDITS_PRINT=/tmp/credits.json npx vitest run src/credit-formatters.ratchet.test.ts`.
 * </p>
 */
const ALLOW: ReadonlyArray<readonly [file: string, lane: "F1" | "F2" | "F3" | "F4"]> = [
  // F2 — none left (P13 F2 migrated all twelve).
  // F3: none left (P13 lane F3 migrated all twelve).
  // F4 — none left (P13 F4 migrated all six).
];

const SRC = __dirname;
const DEFINITION = join("lib", "utils.ts");
const CALL = /\bformat(?:Signed)?Credits\b/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/** Code without comments — prose about the old formatter is not a call to it. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");

function callers(): string[] {
  return sources(SRC)
    .filter((file) => rel(file) !== DEFINITION.split(sep).join("/") && CALL.test(codeOf(file)))
    .map(rel)
    .sort();
}

describe("the deprecated credit formatters (P13 ratchet)", () => {
  const found = callers();
  const allowed = new Set(ALLOW.map(([file]) => file));

  if (process.env.CREDITS_PRINT) writeFileSync(process.env.CREDITS_PRINT, JSON.stringify(found, null, 2));

  it("no new file calls formatCredits or formatSignedCredits — use lib/minutes or <Minutes>", () => {
    expect(found.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("every listed file still calls one — a migrated file comes off the list", () => {
    expect(ALLOW.map(([file]) => file).filter((file) => !found.includes(file))).toEqual([]);
  });

  it("every listed file exists", () => {
    expect(ALLOW.map(([file]) => file).filter((file) => !existsSync(join(SRC, file)))).toEqual([]);
  });

  it("the list names each file once", () => {
    expect(new Set(ALLOW.map(([file]) => file)).size).toBe(ALLOW.length);
  });
});
