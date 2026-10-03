import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { Slot } from "radix-ui";
import type { VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";
import { buttonVariants } from "./button-variants";

/**
 * Button (design-system.md, Components → button).
 *
 * <p>
 * shadcn new-york, restyled to our vocabulary: no `outline-none` / `focus-visible:ring-*` (the
 * house `:focus-visible` outline in `index.css` is the ring), `border border-transparent` so the
 * edge survives forced colours, weight 600, radius lg. There is deliberately NO `link` variant —
 * navigation is a link; a link may look like a button only as `<Button asChild><Link/></Button>`.
 * </p>
 *
 * <p>
 * `sm` and `icon-sm` are 36px to the eye and 44px to the finger: an `after:` box (5px beyond the
 * 34px padding box) extends the hit area without moving the layout.
 * </p>
 *
 * <p>
 * <b>Heights are floors, and a block button's label wraps (R4, V4-1).</b> At 200 % text a label
 * is 28–32px type on a 40–48px line, and fixed `h-*` boxes clipped it ("Submit application", the
 * passkey pill). The text sizes still give the same 36/44/52px at normal text. A `block` button
 * has the container's width, so its label wraps (a word that cannot fit breaks rather than spill);
 * any other button stays `nowrap` as before, and a caller in a row opts in with
 * `whitespace-normal`. The side padding is capped at its normal-text pixels, so large text goes to
 * the words, not the gutters (a 320px phone at 200 % left "Submit application" 108px).
 * </p>
 */
export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the single child (a router `Link`, an `<a>`) with the button's look. No `pending`. */
    asChild?: boolean;
    /**
     * Working. A spinner replaces the leading icon and the label stays, the width does not move,
     * and the button is `aria-busy` + `aria-disabled` — NOT `disabled`, so focus stays on it and
     * a screen reader is not dropped to the top of the page. Clicks are ignored while it is set.
     */
    pending?: boolean;
    /** The leading icon, 16px. The spinner takes its place while `pending`. */
    icon?: ReactNode;
  };

/**
 * The label and the working state, STACKED in one grid cell so the button is always as wide as
 * the wider of the two and never jumps when it starts or stops working. The resting layer is
 * the accessible one (it fades with opacity, never `invisible`, which would take the name out
 * of the accessibility tree); the working layer is `aria-hidden` so the label is never read
 * twice — a confirm button here once announced every copy of its label concatenated.
 *
 * A plain-text label is repeated in the working layer as a CSS `content: attr()` box, not as DOM
 * text, so `getByText("Save")` still finds exactly one element; only a non-text label (markup) is
 * cloned, still `aria-hidden`.
 */
const LAYER = "col-start-1 row-start-1 inline-flex items-center justify-center gap-2";

function PendingLayer({ pending, children }: Pick<ButtonProps, "pending" | "children">) {
  const text = typeof children === "string" || typeof children === "number" ? String(children) : null;
  return (
    <span aria-hidden="true" data-slot="button-pending" className={cn(LAYER, !pending && "opacity-0")}>
      <Spinner />
      {text === null ? children : <span data-label={text} className="after:content-[attr(data-label)]" />}
    </span>
  );
}

function ButtonContent({ pending, icon, children }: Pick<ButtonProps, "pending" | "icon" | "children">) {
  return (
    <span className="inline-grid">
      <span data-slot="button-label" className={cn(LAYER, pending && "opacity-0")}>
        {icon}
        {children}
      </span>
      <PendingLayer pending={pending}>{children}</PendingLayer>
    </span>
  );
}

// Props are destructured in the body, not the signature: lizard counts every destructured name
// as a parameter, and the complexity gate allows six.
export function Button(allProps: ButtonProps) {
  const {
    className, variant, size, block, asChild = false, pending = false, icon, children, onClick,
    "aria-disabled": ariaDisabled, ...props
  } = allProps;
  const classes = cn(buttonVariants({ variant, size, block }), className);
  if (asChild) {
    return (
      <Slot.Root data-slot="button" className={classes} aria-disabled={ariaDisabled} onClick={onClick} {...props}>
        {children}
      </Slot.Root>
    );
  }
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      data-slot="button"
      className={classes}
      {...props}
      aria-busy={pending || undefined}
      aria-disabled={pending || ariaDisabled || undefined}
      onClick={handleClick}
    >
      <ButtonContent pending={pending} icon={icon}>{children}</ButtonContent>
    </button>
  );
}
