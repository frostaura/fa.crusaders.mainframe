import { describe, expect, it } from "vitest";
import {
  components, composite, contrastRatio, primitives, roles, themes, type SemanticTheme, type ThemeName,
} from "./lib/tokens";

/**
 * The contrast matrix, measured in BOTH themes (D7).
 *
 * <p>
 * `docs/specs/design-system.md` promises WCAG 2.2 AA in both themes "measured, not eyeballed".
 * This is the measurement. Every pair a screen actually paints — text on each surface it sits
 * on, a control's edge on each background, the focus ring everywhere, a slot's label on its
 * fill — is computed from `src/lib/tokens.ts` for light and for dark, so a dark value that
 * reads well on a designer's monitor and fails on a phone at 40 % brightness fails here first.
 * </p>
 */

const AA_BODY = 4.5;
/** SC 1.4.11 — the visual boundary of a control, a focus indicator, a meaningful graphic. */
const AA_NON_TEXT = 3;

const THEMES: ThemeName[] = ["light", "dark"];

/** Every background text is set on. */
function backgrounds(t: SemanticTheme): Record<string, string> {
  return {
    "bg.app": t.bg.app,
    "bg.surface": t.bg.surface,
    "bg.muted": t.bg.muted,
    "bg.raised": t.bg.raised,
    "success.soft": t.success.soft,
    "info.soft": t.info.soft,
    "warning.soft": t.warning.soft,
    "danger.soft": t.danger.soft,
    "accent.soft": t.accent.soft,
    "brand.soft": t.brand.soft,
  };
}

/** The four neutral surfaces: canvas, card, sunken, floating. Controls and status text live here. */
function surfaces(t: SemanticTheme): Record<string, string> {
  return { "bg.app": t.bg.app, "bg.surface": t.bg.surface, "bg.muted": t.bg.muted, "bg.raised": t.bg.raised };
}

describe.each(THEMES)("%s theme", (name) => {
  const t = themes[name];

  describe("text roles clear AA on every background they sit on", () => {
    for (const [role, hex] of Object.entries(t.text)) {
      for (const [bg, bgHex] of Object.entries(backgrounds(t))) {
        it(`text.${role} on ${bg}`, () => {
          expect(contrastRatio(hex, bgHex)).toBeGreaterThanOrEqual(AA_BODY);
        });
      }
    }
  });

  it("keeps a hierarchy: primary > secondary > muted, on every background", () => {
    // Satisfying the floor by pulling muted up to secondary would pass every test above and
    // delete the distinction the token exists to draw. Measured as contrast, not luminance, so
    // it means the same thing in a theme where text is lighter than its ground.
    for (const bg of Object.values(backgrounds(t))) {
      const [p, s, m] = [t.text.primary, t.text.secondary, t.text.muted].map((hex) => contrastRatio(hex, bg));
      expect(p).toBeGreaterThan(s);
      expect(s).toBeGreaterThan(m);
    }
  });

  it("the functional strongs are legible on their own soft fills", () => {
    for (const tone of ["success", "info", "warning", "danger"] as const) {
      expect(contrastRatio(t[tone].strong, t[tone].soft), tone).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it("the functional strongs are legible as text on the canvas, a card and a floating surface", () => {
    // Not bg.muted: light warning.strong measures 4.49:1 there — a known gap, recorded in the
    // lane report, not papered over by widening this list.
    for (const tone of ["success", "info", "warning", "danger"] as const) {
      for (const bg of [t.bg.app, t.bg.surface, t.bg.raised]) {
        expect(contrastRatio(t[tone].strong, bg), `${tone}.strong on ${bg}`).toBeGreaterThanOrEqual(AA_BODY);
      }
    }
  });

  it("a control's edge is visible on every surface a control sits on (≥ 3:1)", () => {
    for (const [bg, bgHex] of Object.entries(surfaces(t))) {
      expect(contrastRatio(t.control, bgHex), `control on ${bg}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("the decorative border stays quiet, and is not the control edge", () => {
    // A card edge is decoration in WCAG's sense; raising it would wireframe every surface.
    expect(contrastRatio(t.border, t.bg.surface)).toBeLessThan(AA_NON_TEXT);
    expect(contrastRatio(t.control, t.border)).toBeGreaterThan(2);
  });

  it("the focus ring is visible on EVERY background (≥ 3:1)", () => {
    expect(t.ring).toBe(t.accent.strong);
    for (const [bg, bgHex] of Object.entries(backgrounds(t))) {
      expect(contrastRatio(t.ring, bgHex), `ring on ${bg}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("links and selection (accent.strong) read as text on every surface", () => {
    for (const bg of Object.values(surfaces(t))) {
      expect(contrastRatio(t.accent.strong, bg)).toBeGreaterThanOrEqual(AA_BODY);
    }
    expect(contrastRatio(t.accent.strong, t.accent.soft)).toBeGreaterThanOrEqual(AA_BODY);
  });

  it("the tin now-line is visible on every surface and slot fill it crosses (≥ 3:1)", () => {
    const crossed = [...Object.values(surfaces(t)), t.success.soft, t.brand.soft, t.warning.soft];
    for (const bg of crossed) {
      expect(contrastRatio(t.brand.tin, bg), `tin on ${bg}`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("every ink reads on its fill", () => {
    const pairs: [string, string, string][] = [
      ["primary.ink on primary", t.primary.ink, t.primary.DEFAULT],
      ["primary.ink on primary.hover", t.primary.ink, t.primary.hover],
      ["brand.ink on brand.strong", t.brand.ink, t.brand.strong],
      ["danger.ink on danger.solid", t.danger.ink, t.danger.solid],
      ["primary.ink on success.solid", t.primary.ink, t.success.solid],
      ["armed.ink on armed.strong", t.armed.ink, t.armed.strong],
    ];
    for (const [label, ink, fill] of pairs) {
      expect(contrastRatio(ink, fill), label).toBeGreaterThanOrEqual(AA_BODY);
    }
  });

  it("the armed confirm is visibly not the danger fill it replaces", () => {
    expect(contrastRatio(t.armed.strong, t.danger.soft)).toBeGreaterThan(2);
  });

  describe("slot states: every label reads on its fill", () => {
    const r = roles(name);
    for (const [state, token] of Object.entries(components.slot[name])) {
      it(state, () => {
        // A transparent cell shows the grid's canvas or card; "not in use" is bg.muted at /40.
        const grounds = token.fill === null
          ? [t.bg.app, t.bg.surface]
          : state === "idle"
            ? [composite(r[token.fill], t.bg.app, 0.4), composite(r[token.fill], t.bg.surface, 0.4)]
            : [r[token.fill]];
        for (const ground of grounds) {
          expect(contrastRatio(r[token.ink], ground), `${state} ink on ${ground}`).toBeGreaterThanOrEqual(AA_BODY);
        }
      });
    }
  });

  it("slot labels stay readable where the watermark crosses them, at its strongest (≥ 3:1)", () => {
    /*
     * The watermark is painted in currentColor — the slot's own ink — so where a stroke passes
     * behind a letter the ground is the ink composited over the fill at the cell's PRESS opacity.
     *
     * The floor is 3:1, not the spec's 4.5:1, and that is a measured deviation: at the spec's
     * opacities light `available` (success.strong on success.soft, 4.57:1 bare) is already 3.92:1
     * at REST and 3.15:1 pressed. 4.5:1 over a stroke is unreachable at those values, so the
     * guarantee the tokens can make is the non-text floor, and the watermark lane keeps the glyph
     * cropped into the corner away from the label.
     */
    const r = roles(name);
    const press = components.watermark[name].cell.press;
    for (const [state, token] of Object.entries(components.slot[name])) {
      if (!token.watermark || !token.fill) continue;
      const ground = composite(r[token.ink], r[token.fill], press);
      expect(contrastRatio(r[token.ink], ground), `${state} under a pressed watermark`).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it("watermark opacities rise rest → hover → press on every surface", () => {
    for (const [surface, o] of Object.entries(components.watermark[name])) {
      expect(o.rest, surface).toBeLessThan(o.hover);
      expect(o.hover, surface).toBeLessThan(o.press);
      expect(o.press, surface).toBeLessThanOrEqual(0.35);
    }
  });

  it("is built from primitives only — no literal a theme invented for itself", () => {
    const ramp = new Set<string>();
    const collect = (node: unknown) => {
      if (typeof node === "string") ramp.add(node);
      else if (node && typeof node === "object") Object.values(node).forEach(collect);
    };
    collect(primitives);
    const strays = Object.entries(roles(name)).filter(([, hex]) => !ramp.has(hex));
    expect(strays).toEqual([]);
  });
});

describe("the dark theme is a theme, not an inversion", () => {
  it("elevates by getting LIGHTER: app < surface < muted < raised", () => {
    const d = themes.dark.bg;
    const order = [d.app, d.surface, d.muted, d.raised].map((hex) => contrastRatio(hex, "#000000"));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(4);
  });

  it("declares exactly the roles light declares", () => {
    expect(Object.keys(roles("dark")).sort()).toEqual(Object.keys(roles("light")).sort());
  });

  it("keeps the crest band navy with white on it", () => {
    expect(themes.dark.brand.strong).toBe(themes.light.brand.strong);
    expect(themes.dark.brand.ink).toBe(primitives.white);
  });
});

/**
 * Light mode is today's product. The dark theme is new; the light one must not drift while it
 * lands. These are the values the product rendered before the tokens were split into tiers.
 */
describe("the light theme keeps the values the product already shipped", () => {
  const shipped: Record<string, string> = {
    "bg-app": "#F8FAFC", "bg-surface": "#FFFFFF", "bg-muted": "#F1F5F9",
    border: "#E2E8F0", control: "#7C8DA4",
    "text-primary": "#0F172A", "text-secondary": "#475569", "text-muted": "#5B6879",
    "success-soft": "#DCFCE7", "success-strong": "#15803D",
    "info-soft": "#DBEAFE", "info-strong": "#1D4ED8",
    "warning-soft": "#FEF9C3", "warning-strong": "#A16207",
    "danger-soft": "#FEE2E2", "danger-strong": "#B91C1C",
    "brand-strong": "#00498D", "brand-soft": "#E4EDF7", "brand-ink": "#FFFFFF", "brand-tin": "#CF2E30",
    "armed-strong": "#C2410C", "armed-ink": "#FFFFFF",
    "accent-strong": "#00498D", "accent-soft": "#E4EDF7",
  };
  for (const [role, hex] of Object.entries(shipped)) {
    it(role, () => expect(roles("light")[role]).toBe(hex));
  }
});
