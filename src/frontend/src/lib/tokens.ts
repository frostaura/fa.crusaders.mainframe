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
  /**
   * Hairlines that separate, but do not have to be perceived: card edges, table rules,
   * dividers. Purely decorative in WCAG's sense, so 1.23:1 on white is a design choice.
   */
  border: "#E2E8F0",
  /**
   * The boundary of a control a person has to find and operate — a text field, a select, a
   * drop target.
   *
   * <p>
   * NOT `border`. Every input in the product drew its edge in `#E2E8F0`, which measures
   * <b>1.23:1</b> on the white it sits on. WCAG 2.1 SC 1.4.11 (Non-text Contrast) asks for
   * 3:1 on the visual boundary of a user-interface component, and that success criterion
   * exists for exactly this: an empty text field whose only indication that it is a field is
   * its outline. At 1.23:1 there is, for a good many people, no field on the screen at all —
   * just a label with nothing under it.
   * </p>
   *
   * <p>
   * `#7C8DA4` is the lightest value on this ramp that clears 3:1 against all three background
   * tokens a control is ever set on — 3.39:1 on `bg.surface`, 3.24:1 on `bg.app`, 3.09:1 on
   * `bg.muted` — rather than the first value that passed on white and quietly failed on the
   * muted cards. All three are measured in `tokens.test.ts`.
   * </p>
   */
  control: "#7C8DA4",
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
 * How long things take, and how they get there. One definition, for every consumer.
 *
 * <p>
 * The same three-copy problem the palette had, one layer along. Before this block there were
 * exactly two durations in the Tailwind theme (`fast: 120ms`, `base: 200ms`), one easing curve
 * written as a literal in `index.css`, and a third duration — `duration-300 ease-out` — living
 * alone inside `Toast.tsx`, which is a transition nobody could find by looking at the theme.
 * A feedback theme that adds seven more timings without a home would make that four copies and
 * then eight.
 * </p>
 *
 * <p>
 * <b>The bands are Material 3's, and one number deliberately is not.</b> State-layer response
 * is 50–150 ms, component animation 100–300 ms, and feedback specifically "fast, subtle and
 * never blocking". {@link motion.duration.hold} is 1 200 ms, which is far outside that band on
 * purpose: the band governs how long a thing should take to MOVE, and the hold is not motion,
 * it is reading time. This club's members are older and not confident with a phone; a tick that
 * clears in 200 ms is a tick somebody watching their own finger never sees. It is a tenant
 * setting for the same reason — a club may genuinely want longer.
 * </p>
 *
 * <p>
 * Consumed only through a Tailwind class name (`duration-press`, `ease-out`, `animate-fb-draw`).
 * `tokens.test.ts` asserts that no component file carries a `duration-[…]` or `ease-[…]`
 * arbitrary value, because an arbitrary value is a fourth copy with a different spelling.
 * </p>
 */
export const motion = {
  duration: {
    /** The press compression. Short enough that a tap feels landed rather than laggy. */
    press: "90ms",
    fast: "120ms",
    base: "200ms",
    /** A dialog arriving, a thumb sliding between two segments. */
    enter: "220ms",
    /** An outcome glyph drawing itself, and the fill cross-fading under it. */
    in: "180ms",
    /** How long an outcome stays put before it settles. Reading time, not motion. */
    hold: "1200ms",
    /** Back to rest. Also the whole of a destructive success, which does not celebrate. */
    settle: "240ms",
    /** One failure shake. Three cycles, never repeated. */
    shake: "320ms",
    /** The ceiling on the wallet count-up; the floor and the scaling are in `useCountUp`. */
    count: "600ms",
    /** One breath of the zero-balance chip. Three of these is one burst. */
    breathe: "1400ms",
  },
  easing: {
    /** The curve `index.css`'s affordance layer already uses on every pressable. */
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    /** M3 emphasised-decelerate: arrives quickly, settles softly. Outcomes and entrances. */
    out: "cubic-bezier(0.2, 0, 0, 1)",
    /** Leaves slowly, goes quickly. The press, which should feel like weight. */
    in: "cubic-bezier(0.3, 0, 1, 1)",
  },
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
