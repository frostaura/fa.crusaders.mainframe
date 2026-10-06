import type { ReactNode } from "react";

/**
 * A figure kept on one line with the word after it (R11): "15 minutes", "3 Oct", "Last 7 days".
 * Controls wrap now rather than overflow, and a wrap must never leave a number at the end of one
 * line and its unit at the start of the next. The space after a digit becomes a no-break space;
 * everything else still wraps. Paint only — a control that shows the glued text keeps the plain
 * spelling as its accessible name (an exact-name query and a screen reader see no difference).
 */
export function keepFiguresWhole(text: string): string {
  return text.replace(/(\d) (?=\p{L})/gu, "$1\u00a0");
}

/**
 * A control's label glued for paint (R11 Button; R17 toggle-group items and tab triggers too, the
 * CI "6 Sep" class): only a plain-text label is touched, and a glued one keeps its plain spelling
 * as the accessible name — the name a reader hears, and every test asks for, does not change
 * because the paint learned to keep two words together. A caller's own name always wins.
 */
export function glueFigureLabel(
  children: ReactNode,
  named: { "aria-label"?: string; "aria-labelledby"?: string },
): { label: ReactNode; name?: string } {
  if (typeof children !== "string") return { label: children };
  const label = keepFiguresWhole(children);
  const own = named["aria-label"] !== undefined || named["aria-labelledby"] !== undefined;
  return { label, name: label === children || own ? undefined : children };
}
