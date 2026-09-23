import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { useFieldControl } from "./field";

/**
 * The text-entry surface every input and textarea shares. 16px on phones (iOS zooms the page into
 * anything smaller), 14px from `sm`. The edge is `border-control` — the ≥3:1 non-text contrast
 * role — never the decorative `border`. No `outline-none`: the house `:focus-visible` outline is
 * the focus ring. Invalid swaps the edge to danger; the message itself is `FieldError`'s.
 */
export const fieldSurface =
  "w-full min-w-0 rounded-lg border border-control bg-bg-surface text-base text-text-primary shadow-xs sm:text-sm placeholder:text-text-muted transition-colors duration-fast ease-standard motion-reduce:transition-none disabled:cursor-not-allowed disabled:bg-bg-muted disabled:opacity-60 aria-[invalid=true]:border-danger-strong";

export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  const wired = useFieldControl(props);
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        fieldSurface,
        // The `readonly` ATTRIBUTE, not `:read-only`: the pseudo-class matches every non-editable
        // element — a Select trigger (a <button>), a file input — and would paint it muted forever.
        "flex h-touch px-3 [&[readonly]]:bg-bg-muted",
        "file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-semibold file:text-text-primary",
        className,
      )}
      {...wired}
    />
  );
}
