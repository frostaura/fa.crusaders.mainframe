import { type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

type Variant = "default" | "primary" | "ghost" | "danger" | "outline";

export function Button({
  className, variant = "default", loading, disabled, children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  const variants: Record<Variant, string> = {
    default: "bg-info-soft text-info-strong border border-info-soft hover:bg-info-soft/70",
    /**
     * A real filled primary, for the one action a screen exists for.
     *
     * `default` is deliberately NOT redefined to this. There are dozens of bare `<Button>` call
     * sites across the admin console, and changing the default restyles every one of them
     * unreviewed. docs/specs/design-system.md does say the default variant should use the
     * accent — so `default: bg-info-soft` is in breach of the project's own spec — but that
     * migration is its own change, not something to smuggle in behind a login screen.
     *
     * `hover:bg-brand-strong/90` compiles because brand.strong is literal hex. The identical
     * utility on `accent.strong` emits nothing at all; see the accent block in tailwind.config.
     */
    primary: "bg-brand-strong text-brand-ink border border-brand-strong hover:bg-brand-strong/90",
    ghost: "bg-transparent text-text-secondary hover:bg-bg-muted",
    // `border-control`: an outline button's boundary IS the button — there is no fill to see
    // it by — so SC 1.4.11's 3:1 applies to it more plainly than to anything else here.
    outline: "border border-control bg-bg-surface hover:bg-bg-muted",
    danger: "bg-danger-soft text-danger-strong border border-danger-soft hover:bg-danger-soft/70",
  };
  // The hover lift, the pressed state, the cursor and the focus ring all come from the
  // base layer in index.css, which keys on the element rather than on this component —
  // so a control built without reaching for `Button` still feels like the rest of the
  // product. That was the point of the finding: the fingerprint control on the schedule
  // had a real affordance and nothing else did, so which things could be pressed was
  // something a member learned screen by screen. Only what is specific to this button
  // belongs here.
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg text-sm font-medium",
        variants[variant],
        // The disabled LOOK is suppressed while loading, but `disabled` itself is kept — it is
        // what stops a double submit, which on register means uploading the photo twice. A
        // button that greys out the moment you press it reads as "that broke", which is the
        // opposite of what is happening.
        loading ? "disabled:opacity-100 disabled:cursor-progress" : "disabled:opacity-50",
        className
      )}
      {...props}
    >
      {loading && (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current motion-reduce:animate-none"
        />
      )}
      {children}
    </button>
  );
}

/**
 * What a control that a person types into or picks from looks like.
 *
 * <p>
 * Exported, because this exact string was written out at twelve sites across nine files — every
 * bare `<input type="date">` and every native `<select>` that did not reach for `Input`. Two
 * consequences, and the second is the one that mattered. It drifted: some copies carried
 * `text-text-primary`, some did not, one carried a focus ring the rest lacked. And it carried
 * `border-border` — <b>1.23:1</b> against the white behind it, where WCAG 2.1 SC 1.4.11 asks
 * 3:1 for the boundary of a user-interface component. An empty text field has nothing but its
 * outline to say it is a field; at 1.23:1 there was, for a good many people, no field there.
 * Twelve places to fix that one at a time, or one.
 * </p>
 *
 * <p>
 * `border-control`, not `border-border`: a card edge and a text field have different jobs and
 * only one of them is a control. See `control` in lib/tokens.ts.
 * </p>
 */
/**
 * <b>No `focus:outline-none` (B8), and the reason is measured rather than argued.</b>
 *
 * <p>
 * Reviewer B tabbed through the door log's three filter selects and reported no visible
 * focus indication at all, with a screenshot of a focused select and an unfocused one that
 * are pixel-identical. Two things were true at once, and only one of them was guessed:
 * </p>
 *
 * <ol>
 *   <li>`focus:outline-none` compiles to <code>outline: 2px solid transparent</code> at
 *       (0,2,0), which beats this product's house focus rule — the <code>:focus-visible</code>
 *       block in `index.css`, at (0,1,0) — so a field opted out of the one focus indicator
 *       every other control in the product has, and got a FLUSH ring instead of the offset
 *       outline, which against an existing 1 px border reads as a slightly thicker border.</li>
 *   <li>The replacement ring is a `box-shadow`, and `index.css`'s base layer puts `select` in
 *       the set that transitions `box-shadow` over 200 ms. Measured in Chromium on the built
 *       stylesheet: at t=0 after focus the computed box-shadow is
 *       <code>rgba(0,0,0,0) 0 0 0 0</code> three times over, and only at t=600 ms is it
 *       <code>rgb(0,73,141) 0 0 0 2px</code>. The outline is not in that transition list, so
 *       it is the half that was instant — and it was the half that had been switched off.</li>
 * </ol>
 *
 * <p>
 * Dropping `outline-none` restores the offset, instant, product-wide indicator and keeps the
 * ring as a second cue. Same probe after the change: <code>outline: rgb(0,73,141) 2px
 * solid</code> immediately on focus.
 * </p>
 */
export const fieldClassName = cn(
  "w-full h-11 px-3 rounded-lg border border-control bg-bg-surface text-text-primary placeholder:text-text-muted",
  "focus:ring-2 focus:ring-accent-strong focus:border-accent-strong",
);

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClassName, className)} {...props} />;
}

/**
 * The native select, wearing the same clothes as {@link Input}.
 *
 * A `<select>` was hand-rolled at every one of its eleven call sites, which is why some of them
 * had a focus ring and some did not.
 */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldClassName, className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("block text-sm font-medium text-text-secondary mb-1", className)} {...props} />;
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "success" | "info" | "warning" | "danger"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    muted: "bg-bg-muted text-text-secondary",
    success: "bg-success-soft text-success-strong",
    info: "bg-info-soft text-info-strong",
    warning: "bg-warning-soft text-warning-strong",
    danger: "bg-danger-soft text-danger-strong",
  };
  return <span className={cn("inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium", tones[tone])}>{children}</span>;
}
