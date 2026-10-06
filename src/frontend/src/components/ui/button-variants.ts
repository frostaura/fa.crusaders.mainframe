import { cva } from "class-variance-authority";

/** The design-system button's look (see `button.tsx` for the reasoning behind each size and variant). */
export const buttonVariants = cva(
  [
    // No `whitespace-nowrap` (R11): a label wraps — balanced, centred, a word kept whole — rather than
    // run past its container; `white-space` is inherited, so a deliberately nowrap row (a table head)
    // still keeps its buttons on one line. But only when the CONTAINER is too narrow: `shrink-0`
    // stops a flex row squeezing a button below its label while the text beside it has room to
    // wrap instead ("Cancel" folding to two lines and doubling its height, 2026-10-06).
    "relative inline-flex max-w-full shrink-0 select-none items-center justify-center gap-[min(0.5rem,8px)] text-balance text-center [overflow-wrap:break-word]",
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
      block: { true: "w-full whitespace-normal [overflow-wrap:anywhere]", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
);
