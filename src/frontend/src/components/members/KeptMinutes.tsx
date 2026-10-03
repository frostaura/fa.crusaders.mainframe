import { cn } from "@/lib/utils";
import { minutesCompact, minutesSpoken } from "@/lib/minutes";
import { keepUnits } from "./keepUnits";

/**
 * `<Minutes>` for a figure in a box that may be narrower than it — a balance on a phone card or in
 * the member header: the same pair of spans (the compact form for the eye, the spoken form for a
 * screen reader) and the same tone, with the groups kept whole.
 */
export function KeptMinutes({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("tabular-nums", Math.trunc(value) < 0 && "text-danger-strong", className)}>
      <span aria-hidden="true">{keepUnits(minutesCompact(value))}</span>
      <span className="sr-only">{minutesSpoken(value)}</span>
    </span>
  );
}
