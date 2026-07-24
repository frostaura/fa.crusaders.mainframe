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
          muted: "#94A3B8",
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
