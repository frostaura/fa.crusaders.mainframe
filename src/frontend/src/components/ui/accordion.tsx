import * as React from "react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { CaretDown } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Accordion — Radix, restyled. The Settings page's ten sections live in one (plan R13).
 *
 * <p>
 * The content animates its height with `collapse-down/up`, sized by Radix's
 * `--radix-accordion-content-height`; under reduced motion both the height animation and the
 * caret's rotation stand down (`motion-reduce:*` here, and the `[data-state]` belt in `index.css`).
 * The trigger is the whole 44px row, not the caret.
 * </p>
 */

const Accordion = AccordionPrimitive.Root;

function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("border-b border-border last:border-b-0", className)}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          "no-lift group/accordion flex min-h-touch flex-1 items-center justify-between gap-4 rounded-lg border border-transparent",
          "py-3 text-left text-sm font-semibold text-text-primary transition-colors duration-fast ease-standard",
          "hover:text-accent-strong disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        {children}
        <CaretDown
          size="1rem"
          aria-hidden="true"
          className={cn(
            "shrink-0 text-text-secondary transition-transform duration-base ease-standard",
            "group-data-[state=open]/accordion:rotate-180 motion-reduce:transition-none",
          )}
        />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className={cn(
        "overflow-hidden text-sm text-text-secondary",
        "data-[state=closed]:animate-collapse-up data-[state=open]:animate-collapse-down motion-reduce:animate-none",
      )}
      {...props}
    >
      <div className={cn("pb-4 pt-0", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
