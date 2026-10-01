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
 */
export function MinutesFigure({ value, signed = false }: { value: number; signed?: boolean }) {
  return (
    <>
      <span aria-hidden="true">{signed ? minutesSigned(value) : minutesCompact(value)}</span>
      <span className="sr-only">{minutesSpoken(value, { signed })}</span>
    </>
  );
}
