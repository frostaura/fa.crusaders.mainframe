/**
 * Where the keyboard goes on the desk's Sell sheet after something the admin did not do — a price
 * that moved under a confirm (R10 X10-2) — and after a Next that found a problem (R10 X10-3).
 *
 * <p>
 * A plain `.ts` module, for the reason `deskLedger.ts` gives: lizard's `.tsx` lexer loses its
 * place in JSX and then measures functions that do not exist.
 * </p>
 */

/** The retries, in ms: the confirm settles a task or two after the answer, Radix's exit a little later. */
const STEPS_MS = [0, 32, 64, 128, 256, 512, 1024];

/**
 * Whether focus is nowhere a person put it: the body, `<main>`, a removed node, the sheet's own
 * container (where Radix's focus trap parks it when the focused confirm unmounts), or outside the
 * sheet altogether (a modal sheet has nothing else to hold it).
 */
function adrift(sheet: HTMLElement, active: Element | null): boolean {
  if (active === null || active === document.body || active.tagName === "MAIN") return true;
  if (!active.isConnected || active === sheet) return true;
  return !sheet.contains(active);
}

/**
 * Put the keyboard on the Sell button once the confirm has gone back to rest. While the confirm is
 * still answering, the armed pair holds focus and there is no idle Sell to land on, so it waits; once
 * Sell is back it takes focus only from a vacuum, never from somewhere the admin chose.
 * Returns the cleanup that stands it down.
 */
export function settleOnSell(sheetSelector: string): () => void {
  const timers: number[] = [];
  let index = 0;
  const attempt = () => {
    const sheet = document.querySelector<HTMLElement>(sheetSelector);
    if (!sheet) return;
    const sell = sheet.querySelector<HTMLElement>("[data-sale-confirm] [data-confirm-group] > button:not([data-confirm])");
    if (sell) {
      if (adrift(sheet, document.activeElement)) sell.focus();
      return;
    }
    if (index < STEPS_MS.length) timers.push(window.setTimeout(attempt, STEPS_MS[index++]));
  };
  timers.push(window.setTimeout(attempt, STEPS_MS[index++]));
  return () => timers.forEach((t) => window.clearTimeout(t));
}

/**
 * The first field with a complaint, in reading order. A radio group is not itself focusable, so
 * focus goes to its chosen radio, or its first — where the fixing starts, as Adjust minutes does.
 */
export function focusFirstComplaint(sheetSelector: string): void {
  const invalid = document.querySelector<HTMLElement>(`${sheetSelector} [aria-invalid='true']`);
  if (!invalid) return;
  if (invalid.getAttribute("role") !== "radiogroup") {
    invalid.focus();
    return;
  }
  const radio = invalid.querySelector<HTMLElement>("[role='radio'][aria-checked='true']")
    ?? invalid.querySelector<HTMLElement>("[role='radio']");
  radio?.focus();
}
