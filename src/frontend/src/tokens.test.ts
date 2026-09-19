import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../tailwind.config";
import { chartColors, channels, palette, rootCssVariables, themeable } from "./lib/tokens";

/**
 * The tokens, measured — and the copies of them, pinned.
 *
 * <p>
 * Two jobs. The first is accessibility: `docs/specs/design-system.md` says "WCAG AA contrast on
 * all text/background pairs (the soft palette is built to clear this — verify with a tool)", and
 * it was not — `text.muted` measured 2.56:1 on white at the 11–12px it is used at, carrying the
 * booking grid's time labels, the only thing on that screen saying what time a slot is. That
 * verification belongs in the suite, not in a reviewer's memory.
 * </p>
 *
 * <p>
 * The second is drift. This palette used to exist three times over — `tailwind.config.ts` as
 * literal hex, `index.css` as variables, `Charts.tsx` as eight constants — and they had already
 * come apart: the charts rendered in a retired sky-blue for as long as the crest colours had
 * been in the theme, and nothing failed. `src/lib/tokens.ts` is now the one place a colour is
 * written, and the tests below assert that every consumer still derives from it, including the
 * one consumer that cannot import it. CSS has no imports, so the two lines in `index.css` are
 * the single unavoidable copy — and they are read off disk and compared here.
 * </p>
 */

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (offset: number) => {
    const raw = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG 2.1 contrast ratio, 1–21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const src = (...parts: string[]) => readFileSync(join(__dirname, ...parts), "utf8");
const indexCss = src("index.css");

/** AA for body text. The muted token is used at 11–12px, so the large-text 3:1 relaxation never applies. */
const AA_BODY = 4.5;

/** Backgrounds text is actually set on — all of them from the palette, including the accent tint. */
const BACKGROUNDS: Record<string, string> = {
  "bg.app": palette.bg.app,
  "bg.surface": palette.bg.surface,
  "bg.muted": palette.bg.muted,
  "success.soft": palette.success.soft,
  "info.soft": palette.info.soft,
  "warning.soft": palette.warning.soft,
  "danger.soft": palette.danger.soft,
  "accent.soft": themeable["accent-soft"],
  "brand.soft": palette.brand.soft,
};

describe("every text token clears WCAG AA on every background it is set on", () => {
  for (const [textName, textHex] of Object.entries(palette.text)) {
    for (const [bgName, bgHex] of Object.entries(BACKGROUNDS)) {
      it(`text.${textName} on ${bgName}`, () => {
        expect(contrast(textHex, bgHex)).toBeGreaterThanOrEqual(AA_BODY);
      });
    }
  }
});

describe("the muted token stays muted", () => {
  it("is lighter than text.secondary, or it is not a hierarchy", () => {
    // Guards the other direction: satisfying the floor by setting muted to near-black would
    // pass every test above and delete the distinction the token exists to draw.
    expect(luminance(palette.text.muted)).toBeGreaterThan(luminance(palette.text.secondary));
  });
});

describe("the functional accents stay legible on their own soft backgrounds", () => {
  for (const name of ["success", "info", "warning", "danger"] as const) {
    it(`${name}.strong on ${name}.soft`, () => {
      expect(contrast(palette[name].strong, palette[name].soft)).toBeGreaterThanOrEqual(AA_BODY);
    });
  }
});

/**
 * The club identity surface, measured as a FILL rather than as text on a page background.
 *
 * This is the pair the rest of the suite cannot catch: `brand.strong` is never a background for
 * `text.*`, it is a background for white, and the largest text in the product sits on it.
 */
describe("the club identity surface is legible as a fill", () => {
  it("brand.ink on brand.strong", () => {
    expect(contrast(palette.brand.ink, palette.brand.strong)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("brand.soft on brand.strong", () => {
    expect(contrast(palette.brand.soft, palette.brand.strong)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("brand.strong reads on a white card", () => {
    expect(contrast(palette.brand.strong, palette.bg.surface)).toBeGreaterThanOrEqual(AA_BODY);
  });

  /**
   * docs/specs/design-system.md calls #7AB07A "the Crusaders green" and the seeder writes it
   * into tenant_settings. It measures 2.52:1 on white. Pinned here so that nobody adopts it as
   * a fill or a text colour on the strength of the doc.
   */
  it("refuses the #7AB07A the design spec names, which cannot carry text", () => {
    expect(contrast("#7AB07A", "#FFFFFF")).toBeLessThan(AA_BODY);
  });
});

/**
 * The armed confirm, which nothing measured before it was a token.
 *
 * `ConfirmButton` hardcoded an arbitrary orange fill with white on it: 2.85:1, on the words
 * "Tap to confirm", at the moment a member is being asked to destroy something.
 *
 * The hex is deliberately not written out here. Tailwind's content scanner is a regex over file
 * text and does not know what a comment is, so naming the retired arbitrary-value class in prose
 * put the rule it describes straight back into the built stylesheet — verified by grepping
 * dist/assets/*.css. Documenting a dead class is how you revive it.
 */
describe("the armed confirm can be read", () => {
  it("armed.ink on armed.strong", () => {
    expect(contrast(palette.armed.ink, palette.armed.strong)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("is visibly not the danger fill it replaces, or the second tap is a guess", () => {
    expect(contrast(palette.armed.strong, palette.danger.soft)).toBeGreaterThan(2);
  });
});

/**
 * WCAG 2.1 SC 1.4.11, Non-text Contrast — the criterion nothing in this repo measured.
 *
 * <p>
 * Every text field, select and outline button in the product drew its boundary in the `border`
 * token: <b>1.23:1</b> on the white behind it, where the criterion asks 3:1 for the visual
 * boundary of a user-interface component. An empty text field has nothing but its outline to
 * say that it is a field, so at that ratio there was, for a good many people, no field on the
 * screen — a label with nothing under it.
 * </p>
 *
 * <p>
 * The floor is 3:1, not 4.5:1: 1.4.11 is about perceiving a boundary, not reading text. And it
 * is measured against every background a control is set on, because the first value that
 * passes on white can still fail on a muted card, which is how this sort of fix half-lands.
 * </p>
 */
describe("a control's boundary can actually be seen", () => {
  /** SC 1.4.11. Non-text, so the body floor does not apply — and neither does the relaxation. */
  const AA_NON_TEXT = 3;

  for (const [name, bgHex] of Object.entries({
    "bg.surface": palette.bg.surface,
    "bg.app": palette.bg.app,
    "bg.muted": palette.bg.muted,
  })) {
    it(`control on ${name}`, () => {
      expect(contrast(palette.control, bgHex)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
  }

  it("the decorative border token is still allowed to be quiet", () => {
    // Deliberately NOT held to 3:1. A card edge and a table rule are decoration in WCAG's
    // sense; raising them too would turn every surface in the product into a wireframe. The
    // point of splitting the token was to stop one rule having to serve both jobs.
    expect(contrast(palette.border, palette.bg.surface)).toBeLessThan(AA_NON_TEXT);
  });

  it("is distinguishable from the decorative one, or splitting them achieved nothing", () => {
    expect(contrast(palette.control, palette.border)).toBeGreaterThan(2);
  });

  it("no form control draws its boundary with the decorative token", () => {
    /*
     * The source check, because the measurement above only proves the token is good — not
     * that anything uses it. This was twelve verbatim copies of one class string across nine
     * files, so "fixed the Input component" would have fixed one of twelve.
     */
    const offenders: string[] = [];
    for (const file of listSources("components").concat(listSources("pages"))) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const body = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
      // A className string that dresses a control — h-11 is this product's control height —
      // and still reaches for the decorative border.
      for (const m of body.matchAll(/"[^"]*\bh-11\b[^"]*"/g)) {
        if (/\bborder-border\b/.test(m[0])) offenders.push(`${file.split("/src/")[1]}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Every consumer still derives from the token module.
 *
 * These are the tests that would have caught the three-way drift. Each one fails the moment
 * somebody types a colour somewhere other than `src/lib/tokens.ts`.
 */
describe("nothing keeps its own copy of the palette", () => {
  it("the Tailwind theme is the palette, not a transcription of it", () => {
    const colors = (config.theme?.extend?.colors ?? {}) as Record<string, unknown>;
    expect(colors.bg).toBe(palette.bg);
    expect(colors.text).toBe(palette.text);
    expect(colors.brand).toBe(palette.brand);
    expect(colors.armed).toBe(palette.armed);
    expect(colors.border).toEqual({ DEFAULT: palette.border });
  });

  it("index.css declares exactly the variables the module says it should", () => {
    // CSS cannot import TypeScript, so this pair of lines is the one unavoidable copy in the
    // system. Reading it off disk is what stops it being a copy that can drift.
    for (const [name, value] of Object.entries(rootCssVariables)) {
      expect(indexCss).toContain(`${name}: ${value};`);
    }
  });

  it("the themeable tokens reach CSS as channels, never as hex", () => {
    // `var(--x, #hex)` makes Tailwind emit NO rule at all for every /opacity modifier on the
    // token — not a wrong colour, no rule. Three live classes vanished that way.
    for (const name of Object.keys(themeable)) {
      expect(indexCss).not.toMatch(new RegExp(`--${name}(-rgb)?\\s*:\\s*#`));
    }
    expect(channels(palette.brand.strong)).toBe("0 73 141");
  });

  it("the focus ring reads a variable that exists", () => {
    /*
     * It read `var(--accent-strong, #0369A1)`, and `--accent-strong` has never been defined —
     * so the fallback WAS the value, and every focus ring in the product rendered the sky-blue
     * this palette was moved off. A var() typo resolves silently and no tool warns, so the
     * defined names are asserted rather than trusted.
     */
    // Comments stripped first: the block above this rule in index.css quotes the broken
    // declaration verbatim, and a checker that reads its own explanation is not a checker.
    const live = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const referenced = [...live.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    const declared = new Set(Object.keys(rootCssVariables));
    for (const name of referenced) {
      if (name.startsWith("--accent")) expect(declared).toContain(name);
    }
    expect(indexCss).toContain("outline: 2px solid rgb(var(--accent-strong-rgb, 0 73 141));");
  });

  it("the charts render in the product's own accent", () => {
    // jsdom has no stylesheet, so these resolve to the compiled-in defaults — which is exactly
    // the assertion: the chart accent IS the token, not a constant that once matched it.
    const c = chartColors();
    expect(c.accent).toBe(themeable["accent-strong"]);
    expect(c.accentSoft).toBe(themeable["accent-soft"]);
    expect(c.muted).toBe(palette.text.muted);
    expect(c.grid).toBe(palette.border);
  });

  it("no component writes a colour of its own", () => {
    /*
     * A six-digit hex or a `bg-[#…]` arbitrary value in a component is, by definition, a value
     * outside the token system: unmeasured, unthemeable, and invisible to every test above.
     * Tests and the token module itself are exempt — one measures colours, the other defines
     * them — as is the QR code, which is black on white because a scanner requires it to be.
     */
    const offenders: string[] = [];
    for (const file of listSources("components").concat(listSources("pages"))) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const body = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
      for (const m of body.matchAll(/#[0-9A-Fa-f]{6}\b|bg-\[#[0-9A-Fa-f]{3,8}\]/g)) {
        if (file.endsWith("CourtCode.tsx")) continue;
        offenders.push(`${file.split("/src/")[1]}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** The .ts/.tsx files directly under one of the frontend's source folders. */
function listSources(folder: string): string[] {
  const dir = join(__dirname, folder);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .map((f) => join(dir, f));
}
