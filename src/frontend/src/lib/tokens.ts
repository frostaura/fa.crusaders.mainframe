/**
 * The design tokens. One definition per value, for every consumer, in both themes.
 *
 * <p>
 * Three tiers, and a value only ever moves down them:
 * </p>
 * <ol>
 *   <li><b>{@link primitives}</b> — the ramps (navy, slate, ink, green, blue, amber, red, orange,
 *   tin). Raw hex, named by hue and lightness, meaning nothing on their own.</li>
 *   <li><b>{@link themes}</b> — the semantic roles (`bg.app`, `text.muted`, `control` …) for
 *   `light` and `dark`. Every value is a primitive <i>reference</i>, never a literal —
 *   `tokens.themes.test.ts` checks that every leaf is a primitive.</li>
 *   <li><b>{@link components}</b> — slot states, the watermark and the button, expressed as
 *   semantic role names so they follow the theme.</li>
 * </ol>
 *
 * <p>
 * <b>Colour reaches CSS as RGB channels.</b> A Tailwind `addBase` plugin writes
 * {@link cssVariables} under `:root, .light` and `.dark`, and every Tailwind colour is
 * {@link color}: `rgb(var(--color-x) / <alpha-value>)`. The channel form is load-bearing: the
 * accent was once `var(--accent-soft, #E0F2FE)`, Tailwind cannot inject alpha into an opaque
 * `var()`, and every `/opacity` modifier on it emitted NO CSS AT ALL — `ring-accent-strong/30`
 * was simply absent from the shipped stylesheet. Never put a hex fallback inside a `var()`.
 * </p>
 *
 * <p>
 * It must stay free of browser and Node APIs at module scope: Tailwind imports it from a config
 * file in Node, and the app imports it in a browser. {@link readToken} is the one function that
 * touches the DOM, and it is defensive about not having one.
 * </p>
 *
 * <p>
 * The shapes are DTCG-compatible (a group per tier, references by role name) so a
 * `tokens.dtcg.json` can be generated later; TypeScript stays authoritative because the tests
 * import it. `docs/specs/design-system.md` explains every value; where it and this file
 * disagree, one of them is a bug.
 * </p>
 */

// ---------------------------------------------------------------------------------------------
// Tier 1 — primitives
// ---------------------------------------------------------------------------------------------

/** The ramps. Keys run light → dark within a hue. */
export const primitives = {
  white: "#FFFFFF",
  /** Cool neutrals for the light theme. 350 and 550 are ours, not Tailwind's — see `control`/`text.muted`. */
  slate: {
    50: "#F8FAFC", 100: "#F1F5F9", 200: "#E2E8F0", 350: "#7C8DA4",
    550: "#5B6879", 600: "#475569", 900: "#0F172A", 950: "#020617",
  },
  /** Navy-tinted neutrals for the dark theme: a night, not a void. */
  ink: {
    50: "#E6EDF7", 200: "#B3C0D4", 300: "#90A0B8", 400: "#6B7EA0",
    700: "#24324D", 800: "#1A2740", 850: "#172338", 900: "#101A2C", 950: "#0A1220",
  },
  /** The crest blue and its family. 700 is the crest itself. */
  navy: {
    100: "#E4EDF7", 300: "#8CBAF2", 500: "#2F6DB8", 550: "#2865AE",
    700: "#00498D", 800: "#003B73", 950: "#12294A",
  },
  green: { 100: "#DCFCE7", 400: "#4ADE80", 700: "#15803D", 950: "#0E2A1C" },
  blue: { 100: "#DBEAFE", 300: "#93B8FD", 700: "#1D4ED8", 950: "#12234A" },
  amber: { 100: "#FEF9C3", 400: "#F5C542", 700: "#A16207", 950: "#2E2408" },
  red: { 100: "#FEE2E2", 300: "#FF9B9B", 600: "#C73636", 700: "#B91C1C", 950: "#3A1418" },
  orange: { 700: "#C2410C" },
  /** The one red line on a squash court, and the crest's red. 400 is its dark-theme lift. */
  tin: { 400: "#FF6B6D", 500: "#CF2E30" },
} as const;

const p = primitives;

// ---------------------------------------------------------------------------------------------
// Tier 2 — semantic roles, per theme
// ---------------------------------------------------------------------------------------------

export type ThemeName = "light" | "dark";

/** A semantic theme: every leaf is a hex taken from {@link primitives}. */
export interface SemanticTheme {
  bg: { app: string; surface: string; muted: string; raised: string };
  /** The scrim colour. Its alpha is {@link scrim}, because a role is a colour, not a colour-and-opacity. */
  overlay: string;
  text: { primary: string; secondary: string; muted: string };
  border: string;
  control: string;
  primary: { DEFAULT: string; ink: string; hover: string };
  accent: { strong: string; soft: string };
  brand: { strong: string; ink: string; soft: string; tin: string };
  success: { soft: string; strong: string; solid: string };
  info: { soft: string; strong: string };
  warning: { soft: string; strong: string };
  danger: { soft: string; strong: string; solid: string; ink: string };
  armed: { strong: string; ink: string };
  ring: string;
}

const light: SemanticTheme = {
  bg: { app: p.slate[50], surface: p.white, muted: p.slate[100], raised: p.white },
  overlay: p.slate[900],
  text: {
    primary: p.slate[900],
    secondary: p.slate[600],
    /**
     * Muted, not invisible. Was #94A3B8, 2.56:1 on white at the 11–12px it is used at — and it
     * carried the booking grid's time labels, the only thing on that screen saying what time a
     * slot is.
     */
    muted: p.slate[550],
  },
  /** Hairlines that separate but need not be perceived. Decorative in WCAG's sense: 1.23:1 is a choice. */
  border: p.slate[200],
  /**
   * The edge of every input, select and checkbox — NOT `border`. SC 1.4.11 asks 3:1 for the
   * visual boundary of a control; at `border`'s 1.23:1 an empty field was, for many people, a
   * label with nothing under it. The lightest value clearing 3:1 on every background a control
   * sits on, measured in `tokens.themes.test.ts`.
   */
  control: p.slate[350],
  primary: { DEFAULT: p.navy[700], ink: p.white, hover: p.navy[800] },
  accent: { strong: p.navy[700], soft: p.navy[100] },
  /**
   * The club's own identity, sampled from the crest. A full-bleed fill with white on top, so it
   * is not tenant-themeable: a per-tenant value at 2.5:1 would make the largest text unreadable.
   */
  brand: { strong: p.navy[700], ink: p.white, soft: p.navy[100], tin: p.tin[500] },
  success: { soft: p.green[100], strong: p.green[700], solid: p.green[700] },
  info: { soft: p.blue[100], strong: p.blue[700] },
  warning: { soft: p.amber[100], strong: p.amber[700] },
  danger: { soft: p.red[100], strong: p.red[700], solid: p.red[700], ink: p.white },
  /**
   * The armed half of a two-tap destructive confirm. Orange, not danger: `danger.soft` is already
   * the idle fill there, so arming has to change colour visibly or the second tap is a guess.
   */
  armed: { strong: p.orange[700], ink: p.white },
  ring: p.navy[700],
};

const dark: SemanticTheme = {
  /** Dark elevation is a LIGHTER surface, not a darker shadow: raised > muted > surface > app. */
  bg: { app: p.ink[950], surface: p.ink[900], muted: p.ink[850], raised: p.ink[800] },
  overlay: p.slate[950],
  text: { primary: p.ink[50], secondary: p.ink[200], muted: p.ink[300] },
  border: p.ink[700],
  control: p.ink[400],
  primary: { DEFAULT: p.navy[500], ink: p.white, hover: p.navy[550] },
  accent: { strong: p.navy[300], soft: p.navy[950] },
  /** The brand band stays navy in the dark: the crest does not change colour at night. */
  brand: { strong: p.navy[700], ink: p.white, soft: p.navy[950], tin: p.tin[400] },
  success: { soft: p.green[950], strong: p.green[400], solid: p.green[700] },
  info: { soft: p.blue[950], strong: p.blue[300] },
  warning: { soft: p.amber[950], strong: p.amber[400] },
  danger: { soft: p.red[950], strong: p.red[300], solid: p.red[600], ink: p.white },
  armed: { strong: p.orange[700], ink: p.white },
  ring: p.navy[300],
};

export const themes: Record<ThemeName, SemanticTheme> = { light, dark };

/** The scrim's opacity per theme: the overlay colour at this alpha. */
export const scrim: Record<ThemeName, number> = { light: 0.45, dark: 0.7 };

/**
 * The light theme under its historical name. Consumers that predate the dark theme import it
 * (`AuthShell.test` pins `palette.brand.tin`); new code reads {@link readToken} or a class.
 */
export const palette = light;

/** Every semantic role, flattened to its CSS name: `bg.app` → `bg-app`, `primary.DEFAULT` → `primary`. */
export type RoleName = string;

/** A theme's roles as `{ "bg-app": "#F8FAFC", … }`. */
export function roles(theme: ThemeName): Record<RoleName, string> {
  const out: Record<string, string> = {};
  const walk = (node: object, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
      if (typeof value === "string") out[name] = value;
      else walk(value as object, name);
    }
  };
  walk(themes[theme], "");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tier 3 — component tokens
// ---------------------------------------------------------------------------------------------

/** A slot state: its fill and ink as role names (`null` fill = transparent, the canvas shows). */
export interface SlotToken { fill: RoleName | null; ink: RoleName; watermark: boolean }

export type SlotState =
  | "available" | "mine" | "mine-past" | "booked" | "past" | "hold" | "closed" | "restricted" | "idle";

function slotStates(mineInk: RoleName): Record<SlotState, SlotToken> {
  return {
    available: { fill: "success-soft", ink: "success-strong", watermark: true },
    mine: { fill: "brand-soft", ink: mineInk, watermark: true },
    "mine-past": { fill: "bg-muted", ink: "text-secondary", watermark: false },
    booked: { fill: "bg-muted", ink: "text-secondary", watermark: true },
    past: { fill: null, ink: "text-muted", watermark: false },
    hold: { fill: "bg-muted", ink: "text-secondary", watermark: false },
    closed: { fill: null, ink: "text-muted", watermark: false },
    restricted: { fill: "warning-soft", ink: "warning-strong", watermark: false },
    /** "Court not in use": `bg.muted` at /40, so it reads as absent rather than as a state. */
    idle: { fill: "bg-muted", ink: "text-muted", watermark: false },
  };
}

/** Watermark opacities for one surface. */
export interface WatermarkOpacity { rest: number; hover: number; press: number }
export type WatermarkSurface = "cell" | "card" | "tile" | "cta";

export const components = {
  /**
   * The booking grid's slot states (design-system.md, "Slot-state component tokens").
   *
   * <p>
   * `mine` inks in `brand.strong` in light and `accent.strong` in dark. The spec's table says
   * `brand.strong` for both, but the brand navy deliberately stays #00498D in the dark theme (it
   * is the crest band's fill) and on dark `brand.soft` it measures 1.62:1. The component token is
   * where a role that is right for one theme and unreadable in the other gets resolved.
   * </p>
   */
  slot: {
    light: slotStates("brand-strong"),
    dark: slotStates("accent-strong"),
  } as Record<ThemeName, Record<SlotState, SlotToken>>,
  /** The fingerprint watermark's opacities, per theme and surface. Emitted as `--wm-<surface>-<phase>`. */
  watermark: {
    light: {
      cell: { rest: 0.12, hover: 0.2, press: 0.28 },
      card: { rest: 0.07, hover: 0.11, press: 0.14 },
      tile: { rest: 0.06, hover: 0.09, press: 0.12 },
      cta: { rest: 0.14, hover: 0.2, press: 0.26 },
    },
    dark: {
      cell: { rest: 0.16, hover: 0.24, press: 0.32 },
      card: { rest: 0.1, hover: 0.14, press: 0.18 },
      tile: { rest: 0.09, hover: 0.12, press: 0.15 },
      cta: { rest: 0.16, hover: 0.2, press: 0.26 },
    },
  } as Record<ThemeName, Record<WatermarkSurface, WatermarkOpacity>>,
  /** Glyph size and crop, in px, per surface. The glyph is rotated −15° and painted in currentColor. */
  watermarkGeometry: {
    cell: { size: 36, right: -6, bottom: -8 },
    card: { size: 72, right: -12, bottom: -16 },
    tile: { size: 128, right: -20, bottom: -28 },
    cta: { size: 40, right: -6, bottom: -10 },
  } as Record<WatermarkSurface, { size: number; right: number; bottom: number }>,
  /** Button heights in px (sm keeps a 44px hit area), label weight, and radius key. */
  button: { height: { sm: 36, md: 44, lg: 52 }, weight: 600, radius: "lg" },
} as const;

// ---------------------------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------------------------

/**
 * How long things take, and how they get there.
 *
 * <p>
 * The bands are Material 3's, and one number deliberately is not: {@link motion.duration.hold}
 * is 1 200 ms because it is reading time, not motion. This club's members are older and not
 * confident with a phone; a tick that clears in 200 ms is one somebody watching their own finger
 * never sees. Consumed only through Tailwind names (`duration-press`, `ease-out`); a test bans
 * `duration-[…]`, `ease-[…]` and numeric `duration-N` in components, because an arbitrary value
 * is a second copy with a different spelling.
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
    /** The ceiling on a credits count-up; the floor and the scaling are in `useCountUp`. */
    count: "600ms",
    /** One breath of the zero-balance chip. Three of these is one burst. */
    breathe: "1400ms",
    /** A bottom sheet or side sheet travelling in or out. */
    sheet: "280ms",
    /** One tick of a countdown ring. */
    tick: "1000ms",
  },
  easing: {
    /** The curve the affordance layer uses on every pressable. */
    standard: "cubic-bezier(0.4, 0, 0.2, 1)",
    /** M3 emphasised-decelerate: arrives quickly, settles softly. Outcomes and entrances. */
    out: "cubic-bezier(0.2, 0, 0, 1)",
    /** Leaves slowly, goes quickly. The press, which should feel like weight. */
    in: "cubic-bezier(0.3, 0, 1, 1)",
  },
} as const;

/** Corner radii. sm checkbox · md slot cell · lg button/input · xl card/popover · 2xl dialog/sheet. */
export const radius = {
  sm: "6px", md: "8px", lg: "10px", xl: "14px", "2xl": "20px", full: "9999px",
} as const;

export type ShadowSize = "xs" | "sm" | "md" | "lg";

/** Elevation, per theme. Dark adds a hairline top highlight because a shadow on navy barely reads. */
export const shadow: Record<ThemeName, Record<ShadowSize, string>> = {
  light: {
    xs: "0 1px 2px rgb(15 23 42 / 0.05)",
    sm: "0 1px 3px rgb(15 23 42 / 0.08), 0 1px 2px -1px rgb(15 23 42 / 0.06)",
    md: "0 4px 12px -2px rgb(15 23 42 / 0.10), 0 2px 4px -2px rgb(15 23 42 / 0.06)",
    lg: "0 12px 32px -8px rgb(15 23 42 / 0.18), 0 4px 8px -4px rgb(15 23 42 / 0.08)",
  },
  dark: {
    xs: "0 1px 2px rgb(0 0 0 / 0.40)",
    sm: "0 1px 3px rgb(0 0 0 / 0.45), inset 0 1px 0 rgb(255 255 255 / 0.04)",
    md: "0 6px 16px -4px rgb(0 0 0 / 0.55), inset 0 1px 0 rgb(255 255 255 / 0.05)",
    lg: "0 16px 40px -8px rgb(0 0 0 / 0.65), inset 0 1px 0 rgb(255 255 255 / 0.06)",
  },
};

/** Stacking. Radix portals (popover) sit ABOVE modals, so a select inside a dialog opens on top. */
export const z = {
  base: "0", raised: "10", sticky: "20", "sticky-corner": "25", chrome: "30", actionbar: "35",
  overlay: "40", modal: "50", popover: "60", toast: "70", tooltip: "80", skip: "90",
} as const;

/**
 * Named lengths: touch target, app bar, tab bar, the page widths and the layout slots inside them.
 *
 * <p>
 * <b>Widths</b> (R4 form factor, `max-w-*`). `narrow` 36rem is for single-task linear pages only
 * (auth, change password, top up, not found); `content` 64rem; `wide` 80rem; `page` 120rem is
 * PageShell's `full` frame — admin and data screens, the booking grid at 3xl — never unbounded,
 * so lines stay readable on an ultrawide. (`page`, not `full`: Tailwind's `max-w-full` is 100 %
 * and 33 call sites mean exactly that.) `list` is a split view's master pane, `aside` /
 * `asideWide` a side rail (the wide one from 3xl), `form` one field column inside a wider page.
 * </p>
 *
 * <p>
 * <b>Tiles</b> are the minimum widths an `AutoGrid` packs to: `stat` a figure, `card` an upcoming
 * game or a badge, `panel` a profile or settings section, `wide` a two-up card. In rem, so at
 * 200 % text a grid holds half as many columns instead of squeezing the words.
 * </p>
 *
 * <p>
 * <b>`stickyTop` is 0, not the app bar's 56px.</b> The shell scrolls `<main>`, which sits BELOW
 * the app bar, so a sticky box's `top` is measured from main's top edge — 56px would leave a
 * 56px band of scrolled content showing above every context bar. The full-height panes (a split
 * view's list, a sticky aside) subtract `--app-chrome-height`, which the shell measures.
 * </p>
 */
export const layout = {
  touch: "44px",
  appbar: "56px",
  tabbar: "64px",
  width: {
    narrow: "36rem", content: "64rem", wide: "80rem", page: "120rem",
    list: "24rem", aside: "20rem", asideWide: "24rem", form: "40rem",
    /** R16 L16-5: the nearest size container's width — a rail item never outgrows its rail. */
    container: "100cqw",
  },
  /** R16 L16-5: a rail card — 16rem, capped at the rail (`100cqw`) at large text. */
  railCard: "min(16rem, 100cqw)",
  tile: { stat: "9rem", card: "18rem", panel: "26rem", wide: "34rem" },
  stickyTop: "0px",
  /** Tailwind's breakpoints plus one: a 1920 screen is not a 1536 one with more margin. */
  screens: { "3xl": "1800px" },
} as const;

/**
 * The type scale. Tailwind's t-shirt keys are overridden rather than renamed so tailwind-merge
 * still recognises them; rem so large-text settings scale. `xs` (12px) is the product's floor.
 */
export const typography = {
  fontSize: {
    xs: ["0.75rem", { lineHeight: "1rem" }],
    sm: ["0.875rem", { lineHeight: "1.25rem" }],
    base: ["1rem", { lineHeight: "1.5rem" }],
    lg: ["1.125rem", { lineHeight: "1.625rem" }],
    xl: ["1.25rem", { lineHeight: "1.75rem" }],
    "2xl": ["1.5rem", { lineHeight: "2rem" }],
    "3xl": ["1.875rem", { lineHeight: "2.25rem" }],
    "4xl": ["2.25rem", { lineHeight: "2.5rem" }],
    "5xl": ["3rem", { lineHeight: "1" }],
  } as Record<string, [string, { lineHeight: string }]>,
  fontFamily: {
    sans: ["Figtree Variable", "Figtree", "ui-sans-serif", "system-ui", "sans-serif"],
    display: ["Archivo Variable", "Figtree Variable", "ui-sans-serif", "system-ui", "sans-serif"],
    mono: ["JetBrains Mono Variable", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  } as Record<string, string[]>,
  fontWeight: { heading: "650" } as Record<string, string>,
  letterSpacing: { overline: "0.08em", code: "0.2em", tight: "-0.02em" } as Record<string, string>,
};

// ---------------------------------------------------------------------------------------------
// Emission — what the Tailwind plugin writes, and how Tailwind reads it
// ---------------------------------------------------------------------------------------------

/** `#00498D` → `"0 73 141"`, the form `rgb(… / <alpha-value>)` needs. */
export function channels(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function slotVariables(theme: ThemeName): Record<string, string> {
  const r = roles(theme);
  const out: Record<string, string> = {};
  for (const [state, token] of Object.entries(components.slot[theme])) {
    if (token.fill) out[`--color-slot-${state}-fill`] = channels(r[token.fill]);
    out[`--color-slot-${state}-ink`] = channels(r[token.ink]);
  }
  return out;
}

function watermarkVariables(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [surface, phases] of Object.entries(components.watermark[theme])) {
    for (const [phase, value] of Object.entries(phases)) out[`--wm-${surface}-${phase}`] = String(value);
  }
  return out;
}

/**
 * Every custom property one theme declares: colour roles and slot states as channels, the scrim
 * alpha, the watermark opacities and the elevation shadows. `:root` and `.dark` must declare the
 * same set — `theme-emission.test.ts` — or a role silently falls back to the light value at night.
 */
export function cssVariables(theme: ThemeName): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, hex] of Object.entries(roles(theme))) out[`--color-${name}`] = channels(hex);
  Object.assign(out, slotVariables(theme));
  out["--alpha-overlay"] = String(scrim[theme]);
  Object.assign(out, watermarkVariables(theme));
  for (const [size, value] of Object.entries(shadow[theme])) out[`--shadow-${size}`] = value;
  return out;
}

/** The Tailwind colour value for a role: themed through the variable, and alpha-capable. */
export function color(name: RoleName): string {
  return `rgb(var(--color-${name}) / <alpha-value>)`;
}

/** The scrim: `bg-overlay` is the theme's alpha; `bg-overlay/50` is half of it. */
export function overlayColor(): string {
  return "rgb(var(--color-overlay) / calc(<alpha-value> * var(--alpha-overlay)))";
}

type ColorTree = { [key: string]: string | ColorTree };

/** The semantic theme's shape with every leaf replaced by {@link color} — Tailwind's `colors`. */
export function tailwindColors(): ColorTree {
  const build = (node: object, prefix: string): ColorTree => {
    const out: ColorTree = {};
    for (const [key, value] of Object.entries(node)) {
      const name = key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;
      out[key] = typeof value === "string" ? color(name) : build(value as object, name);
    }
    return out;
  };
  const tree = build(light, "");
  tree.overlay = overlayColor();
  delete tree.ring; // `ring-ring` is a stock shadcn name; the ring is `ringColor.DEFAULT`.
  tree.slot = slotColors();
  return tree;
}

function slotColors(): ColorTree {
  const out: ColorTree = {};
  for (const [state, token] of Object.entries(components.slot.light)) {
    const entry: ColorTree = { ink: color(`slot-${state}-ink`) };
    if (token.fill) entry.fill = color(`slot-${state}-fill`);
    out[state] = entry;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

/** The theme the document is currently painted in. `light` wherever there is no DOM. */
export function activeTheme(): ThemeName {
  try {
    if (typeof document === "undefined") return "light";
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  } catch {
    return "light";
  }
}

function toHex(raw: string): string | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 3 || !parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  return `#${parts.map((part) => Number(part).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

/**
 * A role as a concrete `#RRGGBB`, for consumers that cannot use a class — SVG `fill`, a
 * charting library's props.
 *
 * <p>
 * Reads the live `--color-<name>` off the document so it follows the theme (and any future
 * tenant override), and falls back to the compiled-in value for whichever theme the document is
 * in wherever the property cannot be read (jsdom, SSR, a stylesheet not yet applied). Hex rather
 * than `rgb()` so every consumer — and the contrast tests that measure the charts — reads one
 * format.
 * </p>
 */
export function readToken(name: RoleName): string {
  const theme = activeTheme();
  const fallback = roles(theme)[name] ?? roles("light")[name] ?? "";
  try {
    if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(`--color-${name}`);
    return (raw && toHex(raw)) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Colours for a chart library, read from the LIVE theme on every call.
 *
 * <p>
 * `Charts.tsx` once kept its own block of eight hexes and three had drifted: the accent was a
 * retired sky-blue, and the axis grey a fourth grey nobody chose. Call this at render time
 * (not at module scope) and re-render on a theme change — `useTheme().resolved` is the signal.
 * </p>
 */
export function chartColors() {
  return {
    accent: readToken("accent-strong"),
    accentSoft: readToken("accent-soft"),
    success: readToken("success-strong"),
    successSoft: readToken("success-soft"),
    info: readToken("info-strong"),
    warning: readToken("warning-strong"),
    danger: readToken("danger-strong"),
    /** Axis labels and the zero line. The muted token, not a fourth grey. */
    muted: readToken("text-muted"),
    /** Legend entries are body text and sit on the card, so they get the body colour. */
    legend: readToken("text-primary"),
    /** Gridlines and the tooltip's border: the same hairline every card uses. */
    grid: readToken("border"),
    /** The tooltip's own surface — the raised one, like every other floating thing. */
    tooltip: readToken("bg-raised"),
  };
}

// ---------------------------------------------------------------------------------------------
// Measurement — WCAG 2.x arithmetic, shared by every test that measures a pair
// ---------------------------------------------------------------------------------------------

/** WCAG relative luminance of `#RRGGBB`. */
export function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channel = (offset: number) => {
    const raw = parseInt(value.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `hex` painted at `alpha` over `onto` — what a translucent layer really shows. */
export function composite(hex: string, onto: string, alpha: number): string {
  const channel = (value: string, offset: number) => parseInt(value.replace("#", "").slice(offset, offset + 2), 16);
  const mixed = [0, 2, 4].map((offset) =>
    Math.round(channel(hex, offset) * alpha + channel(onto, offset) * (1 - alpha)));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
