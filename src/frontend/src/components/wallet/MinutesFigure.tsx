import { keepFiguresWhole } from "@/components/ui/figure-text";
import { minutesCompact, minutesSigned, minutesSpoken } from "@/lib/minutes";

/**
 * An amount of minutes in a cell whose INK the caller decides (P13 §7.1).
 *
 * <p>
 * `<Minutes>` paints a negative figure in the danger tone, which is right for a balance and wrong
 * for a ledger: spending your own minutes on a court you chose is not an error, so a debit wears
 * the primary ink and a movement in wears the success ink (`amountInk`). This is the same pair of
 * spans — the compact form for the eye, the spoken one for a screen reader, so nobody hears "h" or
 * "min" — with no tone of its own.
 * </p>
 *
 * <p>
 * R19 L19-3 — each figure glued to its unit ("1\u00a0h 30\u00a0min"): in a sentence that wraps
 * ("Net movement over this period: +1 h 30 min.") the line may break between the hours and the
 * minutes, never between a figure and its unit. Paint only; the spoken form is unchanged.
 * </p>
 */
export function MinutesFigure({ value, signed = false }: { value: number; signed?: boolean }) {
  return (
    <>
      <span aria-hidden="true">{keepFiguresWhole(signed ? minutesSigned(value) : minutesCompact(value))}</span>
      <span className="sr-only">{minutesSpoken(value, { signed })}</span>
    </>
  );
}
