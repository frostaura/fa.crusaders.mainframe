import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Our vocabulary only — a RATCHET over every component and page.
 *
 * <p>
 * Tailwind emits NOTHING for a class it does not know, silently. `bg-background` from a pasted
 * shadcn snippet, `text-muted` without our `text-` prefix, a `dark:` variant on one screen, a
 * `slate-600` somebody reached for: each compiles, ships, and paints either nothing or a colour
 * outside the token system that the dark theme cannot reach and no contrast test measures.
 * `docs/specs/design-system.md` (Foundations, Guards) lists the banned forms; this enforces them.
 * </p>
 *
 * <p>
 * <b>A ratchet, not a wall.</b> The estate predates the rule, so {@link ALLOW} names every file
 * that offended when the rule landed, and WHICH rules it breaks. The test fails when:
 * </p>
 * <ul>
 *   <li>a file not on the list offends, or a listed file breaks a rule it is not listed for — new debt;</li>
 *   <li>a listed file no longer breaks a rule it is listed for — it was fixed, so take it off
 *   the list (the list only ever shrinks, and every phase stays green);</li>
 *   <li>a listed file no longer exists.</li>
 * </ul>
 *
 * <p>
 * `components/ui/` is exempt from `arbitrary-spacing` only: the primitives are where a pixel-exact
 * value is allowed to live, once. To regenerate the list after a sweep:
 * `VOCAB_PRINT=/tmp/vocab.json npx vitest run src/theme-vocabulary.test.ts`, then paste it.
 * </p>
 */

type Rule =
  | "raw-palette" | "dark-variant" | "arbitrary-z" | "arbitrary-text-px" | "stock-shadcn" | "arbitrary-spacing";

/** Preceded by nothing class-like, so `text-text-muted` never matches as `text-muted`. */
const START = String.raw`(?<![\w-])`;
const HUES = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const COLOR_UTILS = "bg|text|border(?:-[xytrbl])?|ring|ring-offset|outline|divide|fill|stroke|from|via|to|decoration|placeholder|caret|shadow";
const STOCK = [
  "bg-background", "text-foreground", "text-muted-foreground", "border-input", "ring-ring", "ring-offset-background",
  "bg-popover", "text-popover-foreground", "bg-card", "text-card-foreground", "text-primary-foreground",
  "bg-secondary", "text-secondary-foreground", "bg-destructive", "text-destructive", "border-destructive",
  "text-destructive-foreground", "bg-muted", "text-muted", "text-accent-foreground", "bg-accent",
].join("|");
const SPACING = "p[xytrbl]?|m[xytrbl]?|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|w|h|min-w|min-h|max-w|max-h|size|scroll-[mp][xytrbl]?";

const RULES: Record<Rule, RegExp> = {
  "raw-palette": new RegExp(`${START}(?:${COLOR_UTILS})-(?:(?:${HUES})-\\d{2,3}|white|black)(?![\\w-])`),
  "dark-variant": new RegExp(`${START}dark:[\\w\\[-]`),
  "arbitrary-z": new RegExp(`${START}-?z-\\[`),
  "arbitrary-text-px": new RegExp(`${START}text-\\[\\d+(?:\\.\\d+)?px\\]`),
  "stock-shadcn": new RegExp(`${START}(?:${STOCK})(?![\\w-])`),
  "arbitrary-spacing": new RegExp(`${START}-?(?:${SPACING})-\\[`),
};

const SRC = __dirname;
const UI = join(SRC, "components", "ui");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [full];
  });
}

/** Code without comments — prose about a banned class is not a use of it. */
function codeOf(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offences(file: string): Rule[] {
  const code = codeOf(file);
  const inUi = file.startsWith(UI);
  return (Object.keys(RULES) as Rule[]).filter((rule) =>
    !(inUi && rule === "arbitrary-spacing") && RULES[rule].test(code));
}

function scan(): Record<string, Rule[]> {
  const out: Record<string, Rule[]> = {};
  for (const file of [...sources(join(SRC, "components")), ...sources(join(SRC, "pages"))]) {
    const found = offences(file);
    if (found.length) out[relative(SRC, file)] = found;
  }
  return out;
}

/**
 * Files that offended when the rule landed, and the rules each one breaks. SHRINK ONLY.
 * A phase that rebuilds a screen removes its entry in the same commit.
 */
const ALLOW: Record<string, Rule[]> = {
  "components/Button.tsx": ["arbitrary-spacing"],
  "components/Card.tsx": ["arbitrary-spacing"],
  "components/ConfirmButton.tsx": ["arbitrary-spacing"],
  "components/Toast.tsx": ["arbitrary-spacing"],
  "components/doors/PrintSheet.tsx": ["arbitrary-spacing"],
  "components/member-door/FullScreenQr.tsx": ["raw-palette", "arbitrary-z"],
  "components/monitoring/CourtTile.tsx": ["arbitrary-spacing"],
  "components/onboarding/Illustrations.tsx": ["arbitrary-spacing"],
  "pages/MyCode.tsx": ["arbitrary-spacing"],
};

describe("theme vocabulary (ratchet)", () => {
  const found = scan();

  if (process.env.VOCAB_PRINT) writeFileSync(process.env.VOCAB_PRINT, JSON.stringify(found, null, 2));

  it("no file breaks a rule it is not already listed for", () => {
    const fresh = Object.entries(found).flatMap(([file, rules]) =>
      rules.filter((rule) => !(ALLOW[file] ?? []).includes(rule)).map((rule) => `${file}: ${rule}`));
    expect(fresh, "new vocabulary debt — use the token names (design-system.md)").toEqual([]);
  });

  it("no listed file has been fixed and left on the list", () => {
    const cleared = Object.entries(ALLOW).flatMap(([file, rules]) =>
      rules.filter((rule) => !(found[file] ?? []).includes(rule)).map((rule) => `${file}: ${rule}`));
    expect(cleared, "fixed — remove these from ALLOW so they cannot regress").toEqual([]);
  });

  it("lists no file that no longer exists", () => {
    expect(Object.keys(ALLOW).filter((file) => !existsSync(join(SRC, file)))).toEqual([]);
  });
});

describe("the rules themselves", () => {
  const hits = (rule: Rule, text: string) => RULES[rule].test(text);

  it("catch the forms they exist for", () => {
    expect(hits("raw-palette", 'className="text-slate-600"')).toBe(true);
    expect(hits("raw-palette", 'className="hover:bg-white/80"')).toBe(true);
    expect(hits("raw-palette", 'className="border-b-amber-200"')).toBe(true);
    expect(hits("dark-variant", 'className="dark:bg-bg-app"')).toBe(true);
    expect(hits("arbitrary-z", 'className="z-[60]"')).toBe(true);
    expect(hits("arbitrary-text-px", 'className="text-[11px]"')).toBe(true);
    expect(hits("stock-shadcn", 'className="bg-background text-foreground"')).toBe(true);
    expect(hits("stock-shadcn", 'className="hover:bg-accent"')).toBe(true);
    expect(hits("stock-shadcn", 'className="text-muted"')).toBe(true);
    expect(hits("arbitrary-spacing", 'className="min-h-[44px]"')).toBe(true);
    expect(hits("arbitrary-spacing", 'className="-mt-[3px]"')).toBe(true);
  });

  it("leave our own vocabulary alone", () => {
    const ours = 'className="bg-bg-app text-text-muted bg-bg-muted border-control bg-accent-soft '
      + 'text-accent-strong bg-primary text-primary-ink hover:bg-primary-hover z-popover text-xs '
      + 'min-h-touch bg-overlay text-danger-strong bg-brand-soft darkened"';
    for (const rule of Object.keys(RULES) as Rule[]) expect(hits(rule, ours), rule).toBe(false);
  });
});
