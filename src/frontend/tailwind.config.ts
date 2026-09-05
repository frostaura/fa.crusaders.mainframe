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
        accent: {
          soft: "var(--accent-soft, #E0F2FE)",
          strong: "var(--accent-strong, #0369A1)",
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
