import type { Config } from "tailwindcss";
import { motion, palette, themeableTailwindValue } from "./src/lib/tokens";

/**
 * Crusaders Mainframe — the Tailwind theme.
 *
 * <p>
 * This file holds no colour values. It used to hold the whole palette as literal hex, which made
 * it the second of three copies — `src/index.css` had the variables and `src/components/Charts.tsx`
 * had eight more constants — and they had already drifted apart from each other. Every value now
 * comes from `src/lib/tokens.ts`, which is the one place a colour is written down; the doc
 * comments explaining *why* each value is what it is moved there with them.
 * </p>
 *
 * <p>
 * Typography, radii, shadows and durations stay here: they have exactly one consumer, which is
 * Tailwind itself, so routing them through a module would add an indirection and remove nothing.
 * </p>
 */
const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1rem" },
    extend: {
      fontFamily: {
        sans: ["Figtree", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      colors: {
        bg: palette.bg,
        border: { DEFAULT: palette.border },
        // The 3:1 boundary for controls — see `control` in tokens.ts.
        control: { DEFAULT: palette.control },
        text: palette.text,
        success: palette.success,
        info: palette.info,
        warning: palette.warning,
        danger: palette.danger,
        brand: palette.brand,
        armed: palette.armed,
        /**
         * The per-tenant pair, as RGB channels through `<alpha-value>` — never `var(--x, #hex)`,
         * which makes every opacity modifier on the token emit no CSS at all. The reasoning, and
         * the three live classes it silently deleted, are on `themeable` in tokens.ts.
         */
        accent: {
          soft: themeableTailwindValue("accent-soft"),
          strong: themeableTailwindValue("accent-strong"),
        },
      },
      borderRadius: { lg: "0.5rem", xl: "0.75rem" },
      boxShadow: {
        sm: "0 1px 2px 0 rgb(15 23 42 / 0.04)",
        md: "0 2px 4px -1px rgb(15 23 42 / 0.06), 0 4px 6px -1px rgb(15 23 42 / 0.08)",
      },
      /**
       * Timing comes from `src/lib/tokens.ts`, for the reason the colours do.
       *
       * This was `{ fast: "120ms", base: "200ms" }` written out here, which was fine while
       * there were two of them and nothing else needed to know. The action-feedback theme
       * needs the same numbers in TypeScript — `useActionFeedback` waits `hold` before it
       * settles, `useCountUp` clamps against `count` — and a component that sets a timer to
       * 1200 while the stylesheet animates for 180 is a component whose motion and whose
       * state machine disagree with nobody able to see it.
       */
      transitionDuration: motion.duration,
      transitionTimingFunction: motion.easing,
      /**
       * The five keyframes the feedback theme and the credits badge need.
       *
       * <p>
       * <b>Every use site must carry `motion-reduce:animate-none` by hand.</b> The
       * `prefers-reduced-motion` block in `index.css` stands down the affordance layer's
       * transitions and transforms; it does not and cannot cover a Tailwind `animation`
       * shorthand, because those are separate declarations on whatever element asks for
       * them. `ConfirmButton`'s spinner records the same thing at its own use site. There is
       * a belt-and-braces rule in `index.css` that kills these five by name under reduce,
       * and the class at the use site is still required — the rule cannot see an animation
       * applied by a class that a future component invents.
       * </p>
       */
      keyframes: {
        /** A refusal. Three cycles of ±3 px, and it never repeats. */
        "fb-shake": {
          "0%,100%": { transform: "translateX(0)" },
          "20%,60%": { transform: "translateX(-3px)" },
          "40%,80%": { transform: "translateX(3px)" },
        },
        /** The outcome mark DRAWS. `24` is the path length every glyph in ActionGlyph pads to. */
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
      },
      animation: {
        "fb-shake": `fb-shake ${motion.duration.shake} linear 1`,
        "fb-draw": `fb-draw ${motion.duration.in} ${motion.easing.out} 1 forwards`,
        "fb-pop": `fb-pop ${motion.duration.in} ${motion.easing.out} 1`,
        "chip-breathe": `chip-breathe ${motion.duration.breathe} ${motion.easing.standard} 3`,
        "flyout-rise": `flyout-rise 900ms ${motion.easing.out} 1 forwards`,
      },
    },
  },
  plugins: [],
};

export default config;
