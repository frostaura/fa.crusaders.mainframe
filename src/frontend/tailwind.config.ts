import type { Config } from "tailwindcss";

/**
 * Crusaders Mainframe — design tokens.
 * Reflects docs/specs/design-system.md: Figtree typography, soft palette,
 * functional accents (success/info/warning/danger), per-tenant brand accent
 * driven by CSS variable so the same build serves every tenant.
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
        bg: {
          app: "#F8FAFC",
          surface: "#FFFFFF",
          muted: "#F1F5F9",
        },
        border: { DEFAULT: "#E2E8F0" },
        text: {
          primary: "#0F172A",
          secondary: "#475569",
          /**
           * Muted, not invisible.
           *
           * Was #94A3B8, which measures 2.56:1 on white and 2.34:1 on bg-muted — well under
           * the 4.5:1 body-text floor docs/specs/design-system.md commits to, at the 11-12px
           * sizes this token is actually used at. The worst case was the booking grid's row
           * labels: the ONLY thing on that screen that says what time a slot is, and the least
           * readable text on the page. This value clears 4.5:1 against every background token
           * in this palette, including the soft chips, and stays visibly lighter than
           * text-secondary so the hierarchy the token exists for survives.
           *
           * tokens.test.ts measures every text/background pair here, so a future "let's lighten
           * this a bit" fails a test rather than a user.
           */
          muted: "#5B6879",
        },
        success: { soft: "#DCFCE7", strong: "#15803D" },
        info:    { soft: "#DBEAFE", strong: "#1D4ED8" },
        warning: { soft: "#FEF9C3", strong: "#A16207" },
        danger:  { soft: "#FEE2E2", strong: "#B91C1C" },
        /**
         * The club's own identity, as LITERAL hex rather than through the tenant variable.
         *
         * Two reasons it is separate from `accent`. First, this pair carries the club's name as
         * a full-bleed fill with white on top, so a per-tenant value that happened to measure
         * 2.5:1 would make the largest text in the product unreadable — and that is not
         * hypothetical: docs/specs/design-system.md calls #7AB07A "the Crusaders green", and
         * #7AB07A is 2.52:1 on white. Second, literal hex means tokens.test.ts can measure it;
         * a var() cannot be measured from the config at all.
         *
         * Values are the club's real crest colours, sampled from the Northwood Crusaders logo:
         * royal blue #00498D, with the red #CF2E30 reserved for the court tin, where the one
         * red line on a squash court actually is.
         *
         * brand.ink on brand.strong 8.98:1 · brand.soft on brand.strong 7.60:1 ·
         * brand.strong on bg.surface 8.98:1. All measured in tokens.test.ts.
         */
        brand: { strong: "#00498D", soft: "#E4EDF7", ink: "#FFFFFF", tin: "#CF2E30" },
        /**
         * Space-separated RGB CHANNELS through `<alpha-value>`, not `var(--x, #hex)`.
         *
         * The hex form silently broke every opacity modifier on these two tokens. Tailwind
         * cannot inject alpha into an opaque `var()`, so it emits NO RULE AT ALL rather than
         * failing — `ring-accent-strong/30`, `hover:border-accent-strong/60` and
         * `bg-accent-soft/50` were simply absent from the built stylesheet. Two of those were
         * live in the product: the active-tab ring in Layout.tsx and the avatar hover border in
         * Layout.tsx and Profile.tsx. Nothing in the source looks wrong, nothing warns, and the
         * effect just never happens. Verified by grepping dist/assets/*.css before and after.
         *
         * The channel form keeps the per-tenant override working — set --accent-strong-rgb to
         * "0 73 141" rather than to a hex string — and makes the alpha modifiers compile.
         *
         * Defaults are Crusaders' own colours, sampled from the club's crest: #00498D royal
         * blue, with a light tint of it for soft surfaces. NOT the #7AB07A that
         * docs/specs/design-system.md calls "the Crusaders green" — that measures 2.52:1 on
         * white, so it can carry neither text nor a focus ring.
         */
        accent: {
          soft: "rgb(var(--accent-soft-rgb, 228 237 247) / <alpha-value>)",
          strong: "rgb(var(--accent-strong-rgb, 0 73 141) / <alpha-value>)",
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
