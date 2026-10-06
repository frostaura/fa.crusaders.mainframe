import { cva } from "class-variance-authority";

/**
 * Badge — a status word in a pill (design-system.md: tones neutral / success / info / warning /
 * danger / brand). `brand` is the solid crest navy with white, because the dark theme keeps the
 * brand navy and navy-on-soft-navy would not clear 4.5:1.
 *
 * <p>
 * The label sits in its own span, so the pill can wrap BETWEEN its words in a narrow row. It
 * never breaks INSIDE one (R9 L9-6): `min-w-0 break-words` let a caller's squeezed row cut
 * "Orga / niser" and "Archi / ved" at 320 / 200 %. The pill floors at its longest word; a caller
 * whose row cannot hold that wraps the row or steps its layout down — never the word. A flex row
 * never squeezes it (`shrink-0`): the text beside it wraps first, and in a table it never wraps at
 * all (`table-keep-whole`).
 * </p>
 *
 * <p>
 * The icon is sized in `em` of the pill's own text (14px beside 12px), so it grows with the
 * words at large text instead of staying a 14px speck beside 24px letters (R9 L6-16).
 * </p>
 */
export const badgeVariants = cva(
  [
    "inline-flex max-w-full shrink-0 items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5",
    "text-xs font-semibold",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&>svg]:size-[1.1667em]",
  ],
  {
    variants: {
      tone: {
        neutral: "bg-bg-muted text-text-secondary",
        success: "bg-success-soft text-success-strong",
        info: "bg-info-soft text-info-strong",
        warning: "bg-warning-soft text-warning-strong",
        danger: "bg-danger-soft text-danger-strong",
        brand: "bg-brand-strong text-brand-ink",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);
