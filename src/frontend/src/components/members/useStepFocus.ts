import { useEffect, useRef } from "react";

/** How a desk sheet's step is named to a screen reader — the Stepper's own words ("Step 2 of 3: Reason"). */
export function stepName(step: number, names: readonly string[]): string {
  return `Step ${step} of ${names.length}: ${names[step - 1] ?? ""}`;
}

/**
 * R7 X7-5 — a desk sheet's Next (and Back) is a new screen, as in the Book sheet: focus goes to the
 * top of the new step's body, which is a group NAMED for the step, so a screen reader hears "Step 2
 * of 3: Reason" instead of staying on a Next that has just changed meaning under it. The receipt
 * (`done`) takes focus too: the confirm it replaced is gone, and focus would fall to `<body>`.
 * Only a CHANGE moves focus — never the first render (the sheet's own open focus stands).
 */
export function useStepFocus(step: number, names: readonly string[], done: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const key = done ? "done" : String(step);
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    ref.current?.focus({ preventScroll: false });
  }, [key]);
  // Drawn as `ref`, `tabIndex={-1}`, `role="group"` and `aria-label={label}` on the step's body —
  // spelled out, not spread: lizard's JSX lexer loses its place at a `{...props}` and swallows the file.
  return [ref, done ? undefined : stepName(step, names)] as const;
}
