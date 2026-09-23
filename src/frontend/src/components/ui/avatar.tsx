import { createContext, useContext, type ComponentProps } from "react";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Avatar — Radix (the image shows only once it has loaded; until then, or if it fails, the
 * fallback does). Sizes 24 / 32 / 40 / 56 / 96 (design-system.md). The fallback is the person's
 * initials on the soft accent, sized to the circle.
 */
export type AvatarSize = 24 | 32 | 40 | 56 | 96;

const BOX: Record<AvatarSize, string> = {
  24: "size-6 text-xs",
  32: "size-8 text-xs",
  40: "size-10 text-sm",
  56: "size-14 text-lg",
  96: "size-24 text-3xl",
};

const AvatarSizeContext = createContext<AvatarSize>(40);

export function Avatar({ className, size = 40, ...props }: ComponentProps<typeof AvatarPrimitive.Root> & { size?: AvatarSize }) {
  return (
    <AvatarSizeContext.Provider value={size}>
      <AvatarPrimitive.Root
        data-slot="avatar"
        data-size={size}
        className={cn("relative flex shrink-0 select-none overflow-hidden rounded-full bg-bg-muted", BOX[size], className)}
        {...props}
      />
    </AvatarSizeContext.Provider>
  );
}

export function AvatarImage({ className, ...props }: ComponentProps<typeof AvatarPrimitive.Image>) {
  return (
    <AvatarPrimitive.Image data-slot="avatar-image" className={cn("aspect-square size-full object-cover", className)} {...props} />
  );
}

/** "Dean Martin" → "DM"; "cher" → "C"; blank → "?". First and last word, so a middle name never crowds. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = Array.from(words[0])[0] ?? "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? "" : "";
  return (first + last).toLocaleUpperCase();
}

type AvatarFallbackProps = ComponentProps<typeof AvatarPrimitive.Fallback> & {
  /** Whose avatar. Drawn as initials, and read as the full name (`role="img"`). */
  name?: string;
};

export function AvatarFallback({ className, name, children, ...props }: AvatarFallbackProps) {
  const size = useContext(AvatarSizeContext);
  const named = name !== undefined && children === undefined;
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      role={named ? "img" : undefined}
      aria-label={named ? name : undefined}
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-strong",
        size >= 56 && "font-display",
        className,
      )}
      {...props}
    >
      {named ? <span aria-hidden="true">{initialsOf(name)}</span> : children}
    </AvatarPrimitive.Fallback>
  );
}
