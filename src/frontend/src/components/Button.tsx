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
    outline: "border border-border bg-bg-surface hover:bg-bg-muted",
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

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary placeholder:text-text-muted",
        "focus:outline-none focus:ring-2 focus:ring-accent-strong focus:border-accent-strong",
        className
      )}
      {...props}
    />
  );
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
