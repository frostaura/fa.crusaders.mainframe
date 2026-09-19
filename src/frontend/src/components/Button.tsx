import { type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

type Variant = "default" | "ghost" | "danger" | "outline";

export function Button({
  className, variant = "default", ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const variants: Record<Variant, string> = {
    default: "bg-info-soft text-info-strong border border-info-soft hover:bg-info-soft/70",
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
      className={cn(
        "inline-flex items-center justify-center h-11 px-5 rounded-lg text-sm font-medium disabled:opacity-50",
        variants[variant],
        className
      )}
      {...props}
    />
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
