import type { ComponentProps, ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { badgeVariants } from "./badge-variants";

/** Badge — a status word in a pill; the look and its reasoning are in `badge-variants.ts`. */
type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants> & {
  /** A leading 14px icon (bold, per the xs-text rule) — a cue beside the word, never instead of it. */
  icon?: ReactNode;
};

export function Badge({ className, tone, icon, children, ...props }: BadgeProps) {
  return (
    <span data-slot="badge" data-tone={tone ?? "neutral"} className={cn(badgeVariants({ tone }), className)} {...props}>
      {icon}
      <span className="[overflow-wrap:normal]">{children}</span>
    </span>
  );
}
