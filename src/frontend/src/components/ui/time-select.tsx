import * as React from "react";
import { Clock } from "@/components/ui/icons";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Choose a time from slice-aligned options (design-system.md: time-select).
 *
 * <p>
 * <b>Never free-typed.</b> Court time is sold in slices; a typed "18:07" is a time the grid cannot
 * book and the server will refuse. The options are generated from `start`, `end` and `stepMinutes`,
 * so every choosable value is aligned by construction, and a `value` that is not one of them shows
 * the placeholder rather than pretending it was chosen.
 * </p>
 *
 * <p>
 * `end` is exclusive by default (a start time must leave room for one slice); `includeEnd` makes it
 * inclusive for an end-time picker. `"24:00"` is accepted as the end of the day.
 * </p>
 */

export type TimeSelectProps = {
  /** First option, `HH:mm`. */
  start: string;
  /** Last boundary, `HH:mm` (`24:00` allowed). Exclusive unless `includeEnd`. */
  end: string;
  stepMinutes: number;
  value: string | null | undefined;
  onChange: (time: string) => void;
  /** Accessible name of the trigger. Omit inside a `Field`, whose label names it. */
  label?: string;
  includeEnd?: boolean;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

const HHMM = /^(\d{1,2}):(\d{2})$/;

function minutesOf(time: string): number | null {
  const match = HHMM.exec(time);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Every aligned option between `start` and `end`. Empty for a nonsense range or step. */
export function timeOptions(start: string, end: string, stepMinutes: number, includeEnd = false): string[] {
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === null || to === null || !(stepMinutes > 0)) return [];
  const out: string[] = [];
  for (let t = from; includeEnd ? t <= to : t < to; t += stepMinutes) out.push(hhmm(t));
  return out;
}

function TimeSelect({
  start,
  end,
  stepMinutes,
  value,
  onChange,
  label,
  includeEnd = false,
  placeholder = "Choose a time",
  disabled,
  id,
  className,
}: TimeSelectProps) {
  const options = React.useMemo(
    () => timeOptions(start, end, stepMinutes, includeEnd),
    [start, end, stepMinutes, includeEnd],
  );
  const current = value && options.includes(value) ? value : "";
  return (
    <Select value={current} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} data-slot="time-select-trigger" className={cn("tabular-nums", className)}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Clock size={16} aria-hidden="true" className="shrink-0 text-text-secondary" />
          <SelectValue placeholder={placeholder} />
        </span>
      </SelectTrigger>
      <SelectContent className="max-h-[min(20rem,var(--radix-select-content-available-height))]">
        {options.map((option) => (
          <SelectItem key={option} value={option} className="tabular-nums">
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { TimeSelect };
