import { type ReactNode } from "react";

/**
 * A sheet that looks like paper on screen and IS paper when printed.
 *
 * <p>
 * <b>The one genuinely new primitive on this surface, and it is justified by absence.</b>
 * There is no print styling anywhere in this product — no `@media print` block existed before
 * the door card needed one — and the alternative is `print:` utilities scattered through a
 * page component, which is how the next printable view forks them. The `@page` rule and the
 * chrome-hiding live in `src/index.css`; what lives here is the frame and the `print:`
 * classes that go with it.
 * </p>
 *
 * <p>
 * On screen it is a bordered preview at roughly the real proportions, because somebody about
 * to print a card in a club with one printer wants to see what is coming out.
 * </p>
 */
export function PrintSheet({ children }: { children: ReactNode }) {
  // R19 L19-6 — the paper margin is 24px at most (its normal-text size, never 48px at 200 %) and
  // 4vw on a narrow phone: `p-6` left a 158px text column on a 320px screen at 200 %. Large text
  // goes to the words, not the margin — the same rule as the buttons' side padding.
  return (
    <div
      data-print-sheet
      className="mx-auto w-full max-w-[148mm] rounded-lg border border-border bg-bg-surface p-[min(1.5rem,24px,4vw)] text-text-primary shadow-sm print:max-w-none print:rounded-none print:border-0 print:p-0 print:shadow-none"
    >
      {children}
    </div>
  );
}
