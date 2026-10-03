import { useContext, useId, useLayoutEffect, useMemo, useState, type ComponentProps } from "react";
import { Label as LabelPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { WarningCircle } from "@/components/ui/icons";
import { FieldContext, type FieldState } from "./field-context";

/**
 * Field (design-system.md, Components → field / input / textarea).
 *
 * <p>
 * One wrapper owns the ids, so a label, its help text and its error can never be wired to the
 * wrong control — a settings page here once rendered every `<label>` without `htmlFor` and left
 * every input on it unlabelled. `FieldLabel` points at the control; the control (`Input`,
 * `Textarea`, `SelectTrigger`, `Checkbox`, `Switch`) reads the same context through
 * `useFieldControl` (`field-context.ts`) and gets its `id`, `aria-describedby` (description, then error — only
 * the parts actually rendered, so no reference dangles) and `aria-invalid`.
 * </p>
 */

type FieldProps = ComponentProps<"div"> & {
  /** Invalid without a rendered `FieldError` (the message lives elsewhere, e.g. a summary). */
  invalid?: boolean;
  /** Use this id for the control instead of a generated one. */
  controlId?: string;
};

/** Stacks label → control (6px) → help/error. */
export function Field({ invalid = false, controlId, className, ...props }: FieldProps) {
  const generated = useId();
  const [hasDescription, setHasDescription] = useState(false);
  const [hasError, setHasError] = useState(false);
  const value = useMemo<FieldState>(() => ({
    controlId: controlId ?? `${generated}-control`,
    descriptionId: `${generated}-description`,
    errorId: `${generated}-error`,
    invalid: invalid || hasError,
    hasDescription,
    hasError,
    setHasDescription,
    setHasError,
  }), [controlId, generated, invalid, hasError, hasDescription]);
  // `grid-cols-1` (minmax(0, 1fr)), not an implicit column (R4, V4-1): an implicit column is
  // floored at its widest child's min-content, and at 200 % text a password field's wrapper
  // pushed the whole field 36px out of the sign-in card.
  return (
    <FieldContext.Provider value={value}>
      <div data-slot="field" data-invalid={value.invalid || undefined} className={cn("grid grid-cols-1 gap-1.5", className)} {...props} />
    </FieldContext.Provider>
  );
}

export function FieldLabel({ className, htmlFor, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  const field = useContext(FieldContext);
  return (
    <LabelPrimitive.Root
      data-slot="field-label"
      htmlFor={htmlFor ?? field?.controlId}
      className={cn("text-sm font-medium text-text-primary", className)}
      {...props}
    />
  );
}

export function FieldDescription({ className, id, ...props }: ComponentProps<"p">) {
  const field = useContext(FieldContext);
  const register = field?.setHasDescription;
  useLayoutEffect(() => {
    if (!register) return undefined;
    register(true);
    return () => register(false);
  }, [register]);
  return (
    <p
      data-slot="field-description"
      id={id ?? field?.descriptionId}
      className={cn("text-sm text-text-secondary", className)}
      {...props}
    />
  );
}

/**
 * The error, said in words beside an icon — colour is never the only signal. Renders nothing
 * (and registers nothing) when it has no message, so a form can always mount it.
 */
export function FieldError({ className, id, children, ...props }: ComponentProps<"p">) {
  const field = useContext(FieldContext);
  const register = field?.setHasError;
  const present = children !== undefined && children !== null && children !== false && children !== "";
  useLayoutEffect(() => {
    if (!register || !present) return undefined;
    register(true);
    return () => register(false);
  }, [register, present]);
  if (!present) return null;
  return (
    <p
      data-slot="field-error"
      id={id ?? field?.errorId}
      className={cn("flex items-start gap-1.5 text-sm font-medium text-danger-strong", className)}
      {...props}
    >
      <WarningCircle aria-hidden="true" size="1rem" weight="bold" className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}
