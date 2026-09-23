import type { ComponentProps, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Badge — a status word in a pill (design-system.md: tones neutral / success / info / warning /
 * danger / brand). `brand` is the solid crest navy with white, because the dark theme keeps the
 * brand navy and navy-on-soft-navy would not clear 4.5:1.
 *
 * <p>
 * The label sits in its own `min-w-0 break-words` span: text directly inside a flex container
 * is an anonymous flex item no selector can reach, floored at min-content, so a long word would
 * push the pill out of its box at 360px instead of breaking.
 * </p>
 */
export const badgeVariants = cva(
  [
    "inline-flex max-w-full items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5",
    "text-xs font-semibold",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
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

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants> & {
  /** A leading 14px icon (bold, per the xs-text rule) — a cue beside the word, never instead of it. */
  icon?: ReactNode;
};

export function Badge({ className, tone, icon, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" data-tone={tone ?? "neutral"} className={cn(badgeVariants({ tone }), className)} {...props}>
      {icon}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}
