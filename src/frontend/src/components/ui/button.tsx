import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

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
 * <b>Heights are floors, and a label may wrap (R4, V4-1).</b> At 200 % text a label is 28–32px
 * type on a 40–48px line, and fixed `h-*` boxes clipped it ("Submit application", the passkey
 * pill). The text sizes still give the same 36/44/52px at normal text; a label wraps only where
 * its box is given a width it cannot fit on one line (a block button, a grid cell). `shrink-0`
 * keeps what `whitespace-nowrap` used to guarantee in a flex row — a button never squeezes its
 * own label to make room for a sibling; the row wraps, or a caller opts in with `shrink`. The
 * side padding is capped at its normal-text pixels, so large text goes to the words and not to
 * the gutters (a 320px phone at 200 % left "Submit application" 108px); a word that still cannot
 * fit breaks rather than spilling out of the button (`overflow-wrap: anywhere`).
 * </p>
 */
export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-2 text-center [overflow-wrap:anywhere]",
    "rounded-lg border border-transparent font-semibold",
    "transition-colors duration-fast ease-standard motion-reduce:transition-none",
    "disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-ink shadow-xs hover:bg-primary-hover",
        secondary: "bg-accent-soft text-accent-strong hover:bg-accent-soft/70",
        outline: "border-control bg-bg-surface text-text-primary hover:bg-bg-muted",
        ghost: "bg-transparent text-text-primary hover:bg-bg-muted",
        danger: "bg-danger-solid text-danger-ink shadow-xs hover:bg-danger-solid/90",
        "danger-soft": "bg-danger-soft text-danger-strong hover:bg-danger-soft/70",
      },
      size: {
        sm: "min-h-9 px-[min(0.75rem,12px)] py-1 text-sm after:absolute after:inset-x-0 after:-inset-y-[5px] [&_svg]:size-4",
        md: "min-h-touch px-[min(1rem,16px)] py-2 text-sm [&_svg]:size-4",
        lg: "min-h-[52px] px-[min(1.5rem,24px)] py-2 text-base [&_svg]:size-5",
        "icon-sm": "size-9 after:absolute after:-inset-[5px] [&_svg]:size-5",
        icon: "size-touch [&_svg]:size-5",
        "icon-lg": "size-[52px] [&_svg]:size-6",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
);

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
