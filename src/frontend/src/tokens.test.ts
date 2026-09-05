import { describe, expect, it } from "vitest";
import config from "../tailwind.config";

/**
 * The accessibility floor, measured rather than asserted.
 *
 * <p>
 * `docs/specs/design-system.md` says "WCAG AA contrast on all text/background pairs (the soft
 * palette is built to clear this — verify with a tool)". It was not: `text.muted` measured
 * 2.56:1 on white and 2.34:1 on `bg.muted`, at the 11–12px sizes it is used at, and it carried
 * the booking grid's time labels — the only thing on that screen saying what time a slot is.
 * </p>
 *
 * <p>
 * The verification the spec asks for belongs in the suite, not in a reviewer's memory. This is
 * a measurement of the tokens themselves, so lightening one to taste fails here rather than in
 * front of a member.
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

type Palette = Record<string, Record<string, string> | string>;
const colors = (config.theme?.extend?.colors ?? {}) as Palette;
const text = colors.text as Record<string, string>;
const bg = colors.bg as Record<string, string>;

/**
 * Backgrounds text is actually set on. The per-tenant `accent.*` pair is a CSS variable rather
 * than a literal, so it cannot be measured from here — its default is included by hand.
 */
const BACKGROUNDS: Record<string, string> = {
  "bg.app": bg.app,
  "bg.surface": bg.surface,
  "bg.muted": bg.muted,
  "success.soft": (colors.success as Record<string, string>).soft,
  "info.soft": (colors.info as Record<string, string>).soft,
  "warning.soft": (colors.warning as Record<string, string>).soft,
  "danger.soft": (colors.danger as Record<string, string>).soft,
  "accent.soft (default)": "#E0F2FE",
};

/** AA for body text. The muted token is used at 11–12px, so the large-text 3:1 relaxation never applies. */
const AA_BODY = 4.5;

describe("every text token clears WCAG AA on every background it is set on", () => {
  for (const [textName, textHex] of Object.entries(text)) {
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
    expect(luminance(text.muted)).toBeGreaterThan(luminance(text.secondary));
  });
});

describe("the functional accents stay legible on their own soft backgrounds", () => {
  const pairs: [string, string, string][] = [
    ["success", (colors.success as Record<string, string>).strong, (colors.success as Record<string, string>).soft],
    ["info", (colors.info as Record<string, string>).strong, (colors.info as Record<string, string>).soft],
    ["warning", (colors.warning as Record<string, string>).strong, (colors.warning as Record<string, string>).soft],
    ["danger", (colors.danger as Record<string, string>).strong, (colors.danger as Record<string, string>).soft],
  ];
  for (const [name, strong, soft] of pairs) {
    it(`${name}.strong on ${name}.soft`, () => {
      expect(contrast(strong, soft)).toBeGreaterThanOrEqual(AA_BODY);
    });
  }
});
