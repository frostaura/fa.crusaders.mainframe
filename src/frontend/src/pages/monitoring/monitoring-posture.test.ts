import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The house rules the new admin surfaces are held to, checked in the SOURCE.
 *
 * <p>
 * <b>Why a source check and not a rendered one.</b> Each of these is a rule about every
 * control on six new screens, and a rendered assertion can only ever cover the states a test
 * happens to drive into existence. The repo already does this for two rules it has paid for
 * — `clubClock.test.ts` greps a list of surfaces for the reader's-locale formatter, and
 * `tokens.test.ts` greps every 44px control for the decorative border token — and both exist
 * because the rendered version of the same check had passed over the defect.
 * </p>
 *
 * <p>
 * Comments and block comments are stripped before matching, so a paragraph explaining why a
 * rule exists cannot itself trip the rule. That is not hypothetical: the first version of the
 * `clubClock` fix failed its own test because the comment above it named the formatter it had
 * just removed.
 * </p>
 */

const ROOT = resolve(__dirname, "..", "..");

/** Every source file this lane owns, as paths relative to `src/`. */
const SURFACES = [
  "pages/monitoring",
  "components/monitoring",
  "components/members",
  "components/ui/state-block.tsx",
  "components/ui/state-block-action.ts",
  "lib/monitoringCopy.ts",
  "lib/deviceFaultCopy.ts",
  "lib/nightCopy.ts",
  "lib/nightTimeline.ts",
  "lib/useControlBoard.ts",
  "lib/deskMinutesCopy.ts",
  "lib/ecoSettings.ts",
  "lib/adminApi.ts",
];

function sourcesUnder(rel: string): string[] {
  const full = resolve(ROOT, rel);
  if (!statSync(full).isDirectory()) return [full];
  return readdirSync(full)
    .filter((name) => /\.tsx?$/.test(name) && !name.includes(".test."))
    .map((name) => resolve(full, name));
}

const FILES = SURFACES.flatMap(sourcesUnder);

/**
 * The path under `src/`, for the test's name. The LAST `/src/`, because a checkout under a
 * directory called `src` (`~/src/<repo>/src/frontend/src/…`) otherwise names every case after
 * the checkout folder.
 */
function nameOf(file: string): string {
  return file.slice(file.lastIndexOf("/src/") + "/src/".length);
}

/** The body with every comment removed — see the header. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*/g, "");
}

describe("the new admin surfaces keep the estate's rules", () => {
  it.each(FILES.map((f) => [nameOf(f), f] as const))(
    "%s uses the design tokens, never a raw palette class",
    (_name, file) => {
      /*
       * `slate-*`, `amber-*`, `emerald-*` and friends are what `AdminDevices` was built from
       * and are exactly why that page and the doors surface next door disagreed about what a
       * warning looks like. A new surface has no excuse: every tone it needs is a token whose
       * contrast `tokens.test.ts` already measures.
       */
      expect(codeOf(file), `${file} reaches past the tokens`)
        .not.toMatch(/\b(?:bg|text|border|ring)-(?:slate|gray|zinc|neutral|stone|amber|emerald|red|green|blue|yellow|orange)-\d{2,3}\b/);
    },
  );

  // "%s writes no dark-mode utility" is RETIRED by D7 (light + dark from day one). The rule it
  // guarded — no `dark:` class in a component — is now estate-wide in theme-vocabulary.test.ts:
  // dark is expressed only by the token variables, never by a variant.

  it.each(FILES.map((f) => [nameOf(f), f] as const))(
    "%s writes its times through lib/clubClock, never the reader's own locale",
    (_name, file) => {
      // The same rule `clubClock.test.ts` holds the doors surface to, applied to the six new
      // screens in the same commit that created them rather than a round later.
      expect(codeOf(file), `${file} writes a time in the reader's zone`).not.toMatch(/\bformatInstant\b/);
      expect(codeOf(file), `${file} formats a date without the club's zone`)
        .not.toMatch(/toLocaleDateString\(undefined|toLocaleTimeString\(undefined|toLocaleString\(undefined/);
    },
  );

  it.each(FILES.map((f) => [nameOf(f), f] as const))(
    "%s sizes no control with a fixed height",
    (_name, file) => {
      /*
       * `min-h-11`, never `h-11` and never `h-9`. A fixed height clips its own words the
       * moment they wrap, which at the 32px root font an older volunteer actually uses they
       * do — and `h-9` is the 36px that WCAG 2.5.5's 44 was measured against on this estate.
       */
      const code = codeOf(file);
      // The lookbehind is the whole of it: `-` is a word boundary, so a bare `\bh-11\b`
      // matches inside `min-h-11` and the rule would reject its own fix.
      expect(code, `${file} fixes a control's height`)
        .not.toMatch(/"[^"]*(?<!min-)\bh-(?:9|10|11)\b[^"]*"/);
      /*
       * A sub-44px FIXED height, and only a fixed one. `min-h-[36px]` paired with
       * `[@media(pointer:coarse)]:min-h-[44px]` is the chrome lane's deliberate answer and a
       * better one than a flat 44: a touch target is a fingertip, so the floor belongs in
       * pixels and must not double with the text at a 32px root font, while a mouse does not
       * need 44. What this rule is actually about is a height that CLIPS its own words.
       */
      expect(code, `${file} ships a sub-44px fixed control height`)
        .not.toMatch(/(?<!min-)\bh-\[3[0-9]px\]/);
    },
  );
});
