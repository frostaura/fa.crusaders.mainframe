import { cn } from "@/lib/utils";
import { minutesCompact, minutesSigned, minutesSpoken } from "@/lib/minutes";
import { keepUnits } from "./keepUnits";

/**
 * `<Minutes>` for a figure in a box that may be narrower than it — a balance on a phone card or in
 * the member header: the same pair of spans (the compact form for the eye, the spoken form for a
 * screen reader) and the same tone, with the groups kept whole. `signed` for a movement ("+18 d 3 h",
 * the Transactions totals — R8 L8-7 split "2 / min" there at 320 / 200 %).
 */
export function KeptMinutes({ value, signed = false, className }: { value: number; signed?: boolean; className?: string }) {
  return (
    <span className={cn("tabular-nums", Math.trunc(value) < 0 && "text-danger-strong", className)}>
      <span aria-hidden="true">{keepUnits(signed ? minutesSigned(value) : minutesCompact(value))}</span>
      <span className="sr-only">{minutesSpoken(value, { signed })}</span>
    </span>
  );
}
