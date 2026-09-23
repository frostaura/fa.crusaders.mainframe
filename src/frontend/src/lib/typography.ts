import { cva, type VariantProps } from "class-variance-authority";

/**
 * The type recipes (design-system.md, Type). One call per role so a page never assembles its
 * own heading out of size + weight + colour + tracking, and two headings of the same rank can
 * never disagree.
 *
 * <p>
 * `display` and `h1` are Archivo at its semi-expanded width — `font-stretch` is the variable
 * font's `wdth` axis, which `index.css` imports. Everything else is Figtree, the body face, so
 * `h2`/`h3` name only a weight: adding `font-sans` beside `font-heading` would make
 * tailwind-merge read both as font FAMILIES and drop one.
 * </p>
 *
 * <p>
 * Colour is part of the recipe (a caption is muted by definition); a use site that needs the
 * text on a filled surface passes its ink class after it — `cn(typography({ variant: "h2" }),
 * "text-brand-ink")` — and tailwind-merge keeps the later one.
 * </p>
 */
export const typography = cva("", {
  variants: {
    variant: {
      /** Big numerals: a balance, a countdown, a court number. Tabular so digits never jostle. */
      display: "font-display font-extrabold [font-stretch:112%] tabular-nums tracking-tight text-4xl text-text-primary",
      /** The page's one h1. */
      h1: "font-display font-bold [font-stretch:108%] tracking-tight text-2xl sm:text-3xl text-text-primary",
      /** Section and dialog titles. */
      h2: "font-heading text-xl text-text-primary",
      h3: "font-semibold text-lg text-text-primary",
      body: "text-base text-text-primary",
      /** Controls, menu items, table cells. */
      ui: "font-medium text-sm text-text-primary",
      /** A field's label. */
      label: "font-medium text-sm text-text-primary",
      /** Help text, timestamps, secondary facts. The 12px floor — nothing smaller exists. */
      caption: "text-xs text-text-muted",
      /** An eyebrow above a heading. */
      overline: "font-semibold text-xs uppercase tracking-overline text-text-secondary",
      /** Figures in running text or a table column: tabular, so a column of credits lines up. */
      numeric: "tabular-nums",
    },
  },
  defaultVariants: { variant: "body" },
});

export type TypographyVariant = NonNullable<VariantProps<typeof typography>["variant"]>;
