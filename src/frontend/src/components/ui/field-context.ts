import { createContext, useContext, type Dispatch, type SetStateAction } from "react";

/**
 * The ids a `Field` owns, shared with its label, help text, error and control (`field.tsx`).
 * Its own module so the components file exports only components.
 */
export type FieldState = {
  controlId: string;
  descriptionId: string;
  errorId: string;
  invalid: boolean;
  hasDescription: boolean;
  hasError: boolean;
  setHasDescription: Dispatch<SetStateAction<boolean>>;
  setHasError: Dispatch<SetStateAction<boolean>>;
};

export const FieldContext = createContext<FieldState | null>(null);

type ControlA11y = {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
};

/**
 * The control's half of the wiring. Explicit props win: a control given its own `id` or
 * `aria-describedby` keeps them (the field's parts are appended to a caller's describedby).
 */
export function useFieldControl<P extends ControlA11y>(props: P): P {
  const field = useContext(FieldContext);
  if (!field) return props;
  const describedBy = [
    props["aria-describedby"],
    field.hasDescription ? field.descriptionId : undefined,
    field.hasError ? field.errorId : undefined,
  ].filter(Boolean).join(" ");
  return {
    ...props,
    id: props.id ?? field.controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
  };
}
