import type { Config } from "tailwindcss";
import { palette, themeableTailwindValue } from "./src/lib/tokens";

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
      transitionDuration: { fast: "120ms", base: "200ms" },
    },
  },
  plugins: [],
};

export default config;
