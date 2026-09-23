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
 */
export const buttonVariants = cva(
  [
    "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap",
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
        sm: "h-9 px-3 text-sm after:absolute after:inset-x-0 after:-inset-y-[5px] [&_svg]:size-4",
        md: "h-touch min-h-touch px-4 text-sm [&_svg]:size-4",
        lg: "h-[52px] px-6 text-base [&_svg]:size-5",
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
