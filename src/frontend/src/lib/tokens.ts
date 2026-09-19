/**
 * The design tokens. One definition per value, for every consumer.
 *
 * <p>
 * Three places used to hold their own copy of this palette: `tailwind.config.ts` as literal hex,
 * `index.css` as CSS variables, and `Charts.tsx` as a block of eight `const ACCENT = "#0369A1"`
 * declarations. They had already drifted. When the accent moved to the club's crest blue, the
 * charts kept rendering in the old sky-blue, because nothing connected them — and
 * `Charts.TEXT_MUTED` was `#6B7280` where the token was `#5B6879`, two greys nobody chose to be
 * different.
 * </p>
 *
 * <p>
 * So this module is the source, and everything else derives from it: Tailwind's theme imports
 * {@link palette}, `index.css` declares the variables in {@link rootCssVariables}, and JS
 * consumers import from here rather than typing a hex. `tokens.test.ts` measures the contrast of
 * every pair and asserts the stylesheet still agrees with this file, so a copy that drifts fails
 * a test rather than a member's eyesight.
 * </p>
 *
 * <p>
 * It must stay free of browser and Node APIs at module scope: Tailwind imports it from a config
 * file in Node, and the app imports it in a browser. {@link themeableToken} is the one function
 * that touches the DOM, and it is defensive about not having one.
 * </p>
 */

/**
 * Fixed colours. These do not change per tenant — they are the product's own furniture, and the
 * functional accents mean the same thing in every club.
 */
export const palette = {
  bg: {
    app: "#F8FAFC",
    surface: "#FFFFFF",
    muted: "#F1F5F9",
  },
  border: "#E2E8F0",
  text: {
    primary: "#0F172A",
    secondary: "#475569",
    /**
     * Muted, not invisible. Was #94A3B8, which measures 2.56:1 on white at the 11–12px sizes
     * this is actually used at — and it carried the booking grid's time labels, the only thing
     * on that screen saying what time a slot is.
     */
    muted: "#5B6879",
  },
  success: { soft: "#DCFCE7", strong: "#15803D" },
  info: { soft: "#DBEAFE", strong: "#1D4ED8" },
  warning: { soft: "#FEF9C3", strong: "#A16207" },
  danger: { soft: "#FEE2E2", strong: "#B91C1C" },
  /**
   * The club's own identity, sampled from the Northwood Crusaders crest.
   *
   * Deliberately NOT part of the themeable accent: this pair carries the club's name as a
   * full-bleed fill with white on top, so a per-tenant value measuring 2.5:1 would make the
   * largest text in the product unreadable. `tin` is the one red line on a squash court.
   */
  brand: { strong: "#00498D", soft: "#E4EDF7", ink: "#FFFFFF", tin: "#CF2E30" },
  /**
   * The armed state of a two-tap destructive confirm.
   *
   * Orange rather than `danger`, deliberately: `danger.soft` is already the button's idle fill
   * on those screens, so arming it has to change colour visibly or the second tap is a guess.
   *
   * `ConfirmButton` hardcoded an arbitrary orange two shades lighter than this, and white on it
   * measured 2.85:1 — the words
   * "Tap to confirm" were the least readable text on the screen at the exact moment a member is
   * being asked to destroy something. This is the same hue two steps darker, at 5.05:1, measured
   * in `tokens.test.ts`. The retired value is not spelled out anywhere: Tailwind scans file text
   * without parsing comments, so writing the old arbitrary-value class in prose rebuilds it.
   */
  armed: { strong: "#C2410C", ink: "#FFFFFF" },
} as const;

/**
 * Colours a tenant may override at runtime, with their Crusaders defaults.
 *
 * <p>
 * These reach CSS as RGB CHANNELS through `<alpha-value>`, never as `var(--x, #hex)`. Tailwind
 * cannot inject an alpha channel into an opaque `var()`, so with the hex form every `/opacity`
 * modifier on these tokens emitted NO CSS AT ALL — `ring-accent-strong/30` and
 * `hover:border-accent-strong/60` were simply absent from the shipped stylesheet, with nothing
 * in the source looking wrong. See the accent block in `tailwind.config.ts`.
 * </p>
 */
export const themeable = {
  "accent-strong": palette.brand.strong,
  "accent-soft": palette.brand.soft,
} as const;

export type ThemeableToken = keyof typeof themeable;

/** `#00498D` → `"0 73 141"`, the form `rgb(… / <alpha-value>)` needs. */
export function channels(hex: string): string {
  const value = hex.replace("#", "");
  const n = parseInt(value, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * The `:root` custom properties `index.css` declares. Asserted against the stylesheet in
 * `tokens.test.ts`, so the two cannot drift.
 */
export const rootCssVariables: Record<string, string> = Object.fromEntries(
  Object.entries(themeable).map(([name, hex]) => [`--${name}-rgb`, channels(hex)]),
);

/** The Tailwind colour value for a themeable token: overridable, and alpha-capable. */
export function themeableTailwindValue(name: ThemeableToken): string {
  return `rgb(var(--${name}-rgb, ${channels(themeable[name])}) / <alpha-value>)`;
}

/**
 * A themeable token as a concrete colour string, for consumers that cannot use a CSS class —
 * SVG `fill`, a charting library's props.
 *
 * <p>
 * Reads the live custom property so a tenant override is honoured, and falls back to the
 * compiled-in default wherever there is no DOM to read (jsdom, SSR) or the property is unset.
 * This is what keeps charts on the same accent as everything else instead of a hardcoded copy
 * that silently ages.
 * </p>
 */
export function themeableToken(name: ThemeableToken): string {
  const fallback = themeable[name];
  try {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${name}-rgb`).trim();
    if (!raw) return fallback;
    // Channels, e.g. "0 73 141". Anything else is a stylesheet someone hand-edited wrongly;
    // prefer the known-good default over emitting an invalid colour.
    return /^\d{1,3}(\s+\d{1,3}){2}$/.test(raw) ? `rgb(${raw.split(/\s+/).join(", ")})` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Colours for consumers that hand a chart library a string and cannot use a class.
 *
 * <p>
 * `Charts.tsx` kept its own block of eight hexes. Three had drifted and nothing said so: the
 * accent was still `#0369A1`, the sky-blue from before the club's crest colours landed, so every
 * chart in the product rendered in an accent that appears nowhere else on the screen around it;
 * `ACCENT_SOFT` was `#E0F2FE`, that same dead palette's tint; and the axis grey was `#6B7280`
 * where the token is `#5B6879`. The gridlines and the tooltip border were `#E5E7EB`, a fourth
 * grey that is neither `border` nor `text.muted` and that nobody chose.
 * </p>
 *
 * <p>
 * Read through {@link themeableToken} rather than as constants, so the accent follows a tenant
 * override the same way a CSS class does.
 * </p>
 */
export function chartColors() {
  return {
    accent: themeableToken("accent-strong"),
    accentSoft: themeableToken("accent-soft"),
    success: palette.success.strong,
    successSoft: palette.success.soft,
    warning: palette.warning.strong,
    danger: palette.danger.strong,
    /** Axis labels and the zero line. The muted token, not a fourth grey. */
    muted: palette.text.muted,
    /** Legend entries are body text and sit on the card, so they get the body colour. */
    legend: palette.text.primary,
    /** Gridlines and the tooltip's border: the same hairline every card in the product uses. */
    grid: palette.border,
  };
}
