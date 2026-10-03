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
