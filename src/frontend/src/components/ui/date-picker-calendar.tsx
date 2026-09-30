import { format } from "date-fns";
import { TZDate } from "react-day-picker";
import { Calendar } from "@/components/ui/calendar";
import { partsOf } from "@/components/ui/date-picker-day";

/**
 * The calendar half of `DatePicker`, in a module of its own so it loads when a picker first
 * opens rather than with the app: react-day-picker, date-fns and the zone-aware `TZDate` are the
 * heaviest thing a member's first screen would otherwise carry for a control most visits never
 * open (P10 bundle budget).
 */

/** The club day as the calendar's Date: midnight of that day IN the zone. */
function toCalendarDate(day: string | null | undefined, zone: string | undefined): Date | undefined {
  const parts = partsOf(day);
  if (!parts) return undefined;
  return zone ? new TZDate(parts[0], parts[1], parts[2], zone) : new Date(parts[0], parts[1], parts[2]);
}

/**
 * The calendar's Date back to the club day it names. A `TZDate`'s getters answer in its zone, so
 * `date-fns` reads the zone's calendar day; a plain Date (no zone known) reads the local one.
 */
function toClubDay(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

type PanelProps = { value: string | null | undefined; min?: string; max?: string; zone: string | undefined; onPick: (day: string) => void };

export default function DateCalendar({ value, min, max, zone, onPick }: PanelProps) {
  const selected = toCalendarDate(value, zone);
  const first = toCalendarDate(min, zone);
  const last = toCalendarDate(max, zone);
  const disabled = [first ? { before: first } : null, last ? { after: last } : null].filter((m) => m !== null);
  return (
    <Calendar
      mode="single"
      required
      timeZone={zone}
      selected={selected}
      defaultMonth={selected ?? first}
      startMonth={first}
      endMonth={last}
      disabled={disabled}
      onSelect={(date: Date) => onPick(toClubDay(date))}
      // R3 X-7 — opens with focus on the chosen day (today when none), not on the ×: the arrow
      // keys then move through the month at once. It focuses on mount, so a calendar that
      // arrives after the sheet has opened (the lazy chunk) still takes focus from the ×.
      autoFocus
      className="mx-auto"
    />
  );
}
