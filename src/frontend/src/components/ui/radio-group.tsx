import { useId, type ComponentProps, type ReactNode } from "react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * RadioGroup + RadioCard (design-system.md, Components). Radix roving focus: Tab enters the
 * group once, the arrow keys move AND select. Both items are `no-lift` — a radio is chosen.
 */
export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-3", className)} {...props} />;
}

/** The dot: 20px, 2px control edge, a 44px hit area from an `after:` box. */
function RadioDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-control bg-bg-surface",
        "group-data-[state=checked]:border-primary",
        // F4-5: in forced colours the ring of a chosen dot is Highlight, and its fill (below) CanvasText.
        "forced-colors:group-data-[state=checked]:border-[Highlight]",
        className,
      )}
    >
      <span className="size-2.5 scale-0 rounded-full bg-primary transition-transform duration-fast ease-standard motion-reduce:transition-none group-data-[state=checked]:scale-100 forced-colors:bg-[CanvasText]" />
    </span>
  );
}

export function RadioGroupItem({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "no-lift group relative shrink-0 rounded-full border border-transparent after:absolute after:-inset-3",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioDot />
    </RadioGroupPrimitive.Item>
  );
}

type RadioCardProps = Omit<ComponentProps<typeof RadioGroupPrimitive.Item>, "title"> & {
  /** The option's name — its whole accessible name. */
  title: ReactNode;
  /** A line of detail, wired as the description rather than read as part of the name. */
  description?: ReactNode;
};

/**
 * A radio the size of a choice: a card with a title, an optional description and the dot.
 * Selected = accent edge + soft accent fill + filled dot (never colour alone).
 */
export function RadioCard({ className, title, description, children, ...props }: RadioCardProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = description ? `${id}-description` : undefined;
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-card"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className={cn(
        "no-lift group flex min-h-touch w-full items-start gap-3 rounded-xl border border-border bg-bg-surface p-4 text-left",
        "transition-colors duration-fast ease-standard motion-reduce:transition-none hover:bg-bg-muted",
        "data-[state=checked]:border-accent-strong data-[state=checked]:bg-accent-soft",
        // F4-5: a heavier Highlight edge — the fill is not a system colour and would be discarded.
        "forced-colors:data-[state=checked]:border-[3px] forced-colors:data-[state=checked]:border-[Highlight]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioDot className="mt-0.5" />
      <span className="grid min-w-0 flex-1 gap-1">
        <span id={titleId} className="break-words text-sm font-semibold text-text-primary">{title}</span>
        {description ? (
          <span id={descriptionId} className="break-words text-sm text-text-secondary">{description}</span>
        ) : null}
        {children}
      </span>
    </RadioGroupPrimitive.Item>
  );
}
