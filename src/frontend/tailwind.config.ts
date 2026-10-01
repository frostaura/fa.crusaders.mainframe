import type { Config } from "tailwindcss";
import plugin from "tailwindcss/plugin";
import containerQueries from "@tailwindcss/container-queries";
import {
  color, cssVariables, layout, motion, radius, tailwindColors, typography, z,
} from "./src/lib/tokens";

/**
 * Crusaders Mainframe — the Tailwind theme.
 *
 * <p>
 * This file holds no values. Every colour, size, radius, shadow, duration and layer comes from
 * `src/lib/tokens.ts`, the one place a value is written down, with the reasoning for each.
 * </p>
 *
 * <p>
 * <b>Themes are variables, not variants.</b> The plugin below writes every role as an RGB-channel
 * custom property under `:root, .light` and again under `.dark`; every colour here reads its
 * variable through `<alpha-value>`. So `bg-bg-surface` is correct in both themes with no `dark:`
 * anywhere — `theme-vocabulary.test.ts` forbids `dark:` in components and pages, and
 * `theme-emission.test.ts` proves the two blocks declare the same keys.
 * </p>
 */
const themeVariables = plugin(({ addBase }) => {
  addBase({
    ":root, .light": { colorScheme: "light", ...cssVariables("light") },
    ".dark": { colorScheme: "dark", ...cssVariables("dark") },
    // Paper is white: a page printed from the dark theme (the door card) prints in light.
    "@media print": { ".dark": { colorScheme: "light", ...cssVariables("light") } },
  });
});

/** `var(--shadow-<size>)`: the elevation follows the theme like a colour does. */
const boxShadow = {
  xs: "var(--shadow-xs)",
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
};

/**
 * The default ring colour, as a FUNCTION colour. Tailwind resolves `ringColor.DEFAULT` into the
 * `--tw-ring-color` default by parsing it as a colour; `rgb(var(…) / <alpha-value>)` does not
 * parse, and the parse failure silently falls back to Tailwind's own blue-300. A function colour
 * is called instead of parsed.
 */
const ringDefault = (({ opacityValue }: { opacityValue?: string }) =>
  `rgb(var(--color-ring) / ${opacityValue ?? "1"})`) as unknown as string;

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  /*
   * `.dark` and `.light` are base-layer selectors, and Tailwind drops a base rule whose class
   * never appears in the scanned content. Today `lib/theme.tsx` happens to spell "dark"; the day
   * it stops, the whole dark theme would vanish from the build with no error. Safelisted, and
   * `theme-emission.test.ts` compiles against content that never mentions either.
   */
  safelist: ["dark", "light"],
  // A lift that sticks after a tap is a touch bug, not an affordance: hover only where it exists.
  future: { hoverOnlyWhenSupported: true },
  theme: {
    container: { center: true, padding: "1rem" },
    extend: {
      // R4 form factor: `3xl` (1800px) — extended, so sm…2xl keep their defaults.
      screens: layout.screens,
      colors: tailwindColors(),
      // A bare `border` / `divide-*` gets the decorative hairline, and a bare `ring` the accent —
      // never Tailwind's gray-200 / blue-500, which would glare in the dark theme.
      borderColor: { DEFAULT: color("border") },
      ringColor: { DEFAULT: ringDefault },
      // Used verbatim as `--tw-ring-offset-color`, so no `<alpha-value>` placeholder here.
      ringOffsetColor: { DEFAULT: "rgb(var(--color-bg-surface))" },
      fontSize: typography.fontSize,
      fontFamily: typography.fontFamily,
      fontWeight: typography.fontWeight,
      letterSpacing: typography.letterSpacing,
      borderRadius: radius,
      boxShadow,
      zIndex: z,
      spacing: { touch: layout.touch, appbar: layout.appbar, tabbar: layout.tabbar },
      minHeight: { touch: layout.touch },
      minWidth: { touch: layout.touch },
      height: { touch: layout.touch },
      size: { touch: layout.touch },
      maxWidth: layout.width,
      transitionDuration: motion.duration,
      transitionTimingFunction: motion.easing,
      /**
       * Every use site of these must carry `motion-reduce:animate-none` by hand. The
       * reduced-motion block in `index.css` stands down the affordance layer and, by name, the
       * feedback keyframes and every Radix `[data-state]` animation; it cannot see an animation
       * a future component invents.
       */
      keyframes: {
        /** A refusal. Three cycles of ±3 px, and it never repeats. */
        "fb-shake": {
          "0%,100%": { transform: "translateX(0)" },
          "20%,60%": { transform: "translateX(-3px)" },
          "40%,80%": { transform: "translateX(3px)" },
        },
        /** The outcome mark DRAWS. `24` is the path length every glyph pads to. */
        "fb-draw": { from: { strokeDashoffset: "24" }, to: { strokeDashoffset: "0" } },
        /** …and arrives with it. Affirmative outcomes only; a deletion does not pop. */
        "fb-pop": {
          from: { transform: "scale(0.6)", opacity: "0" },
          to: { transform: "scale(1)", opacity: "1" },
        },
        /** The zero-balance chip. 3.5 % is under one pixel of reflow on a 44 px chip. */
        "chip-breathe": {
          "0%,100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.035)" },
        },
        /** `+50.00` rising off the chip and fading. Decoration: always `aria-hidden`. */
        "flyout-rise": {
          from: { transform: "translateY(4px)", opacity: "0" },
          "25%": { transform: "translateY(0)", opacity: "1" },
          to: { transform: "translateY(-10px)", opacity: "0" },
        },
        /** A scrim fading in and out under a dialog or sheet. */
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "overlay-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        /** Popovers, menus, centred dialogs: a small scale plus a fade. */
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "pop-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.96)" },
        },
        /** A bottom sheet. */
        "sheet-up": { from: { transform: "translateY(100%)" }, to: { transform: "translateY(0)" } },
        "sheet-down": { from: { transform: "translateY(0)" }, to: { transform: "translateY(100%)" } },
        /** Accordion content, sized by Radix. */
        "collapse-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "collapse-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "fb-shake": `fb-shake ${motion.duration.shake} linear 1`,
        "fb-draw": `fb-draw ${motion.duration.in} ${motion.easing.out} 1 forwards`,
        "fb-pop": `fb-pop ${motion.duration.in} ${motion.easing.out} 1`,
        "chip-breathe": `chip-breathe ${motion.duration.breathe} ${motion.easing.standard} 3`,
        "flyout-rise": `flyout-rise 900ms ${motion.easing.out} 1 forwards`,
        "overlay-in": `overlay-in ${motion.duration.enter} ${motion.easing.out}`,
        "overlay-out": `overlay-out ${motion.duration.fast} ${motion.easing.in} forwards`,
        "pop-in": `pop-in ${motion.duration.enter} ${motion.easing.out}`,
        "pop-out": `pop-out ${motion.duration.fast} ${motion.easing.in} forwards`,
        "sheet-up": `sheet-up ${motion.duration.sheet} ${motion.easing.out}`,
        "sheet-down": `sheet-down ${motion.duration.enter} ${motion.easing.in} forwards`,
        "collapse-down": `collapse-down ${motion.duration.base} ${motion.easing.out}`,
        "collapse-up": `collapse-up ${motion.duration.base} ${motion.easing.out}`,
      },
    },
  },
  /*
   * Container queries (`@container/name`, `@[64rem]/name:`; pinned, official). Layout inside the
   * admin frame is decided by the width the page actually has, not the viewport: the rail takes
   * 16rem from xl, so a viewport breakpoint lies there (R4 form factor, SPEC 2.0).
   */
  plugins: [themeVariables, containerQueries],
};

export default config;
