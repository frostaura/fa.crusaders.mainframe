import { cn } from "../lib/utils";
import { minutesCompact, minutesSigned, minutesSpoken } from "../lib/minutes";

export type MinutesProps = {
  /** Whole minutes; a fraction is truncated toward zero (`lib/minutes`). */
  value: number;
  /** A movement: "+1 h" / "−45 min", read as "plus 1 hour" / "minus 45 minutes". */
  signed?: boolean;
  className?: string;
};

/**
 * An amount of minutes, the way every screen shows one (P13 contract §7.1).
 *
 * <p>
 * The compact form ("1 h 30 min") is what the eye reads and is `aria-hidden`; the long form
 * ("1 hour 30 minutes") is what a screen reader hears, in an `sr-only` span — so nobody hears
 * "h", "d" or "min". Tabular figures so a column of amounts lines up, and a negative value
 * wears the existing negative tone (`text-danger-strong`, as the member list's balance does).
 * </p>
 */
export function Minutes({ value, signed = false, className }: MinutesProps) {
  const shown = signed ? minutesSigned(value) : minutesCompact(value);
  const spoken = minutesSpoken(value, { signed });
  return (
    <span className={cn("tabular-nums", Math.trunc(value) < 0 && "text-danger-strong", className)}>
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
}
