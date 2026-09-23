import * as React from "react";
import { format } from "date-fns";
import { TZDate } from "react-day-picker";
import { CalendarBlank } from "@/components/ui/icons";
import { Calendar } from "@/components/ui/calendar";
import { fieldSurface } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsSmUp } from "@/components/ui/use-media-query";
import { clubZone } from "@/lib/clubZone";
import { cn } from "@/lib/utils";

/**
 * Pick a club day (design-system.md: calendar + date-picker).
 *
 * <p>
 * <b>The value is a club day, `YYYY-MM-DD`, never an instant.</b> The schedule, the bounds and the
 * API all speak in club days (`lib/gridClock`), and an instant would re-open the question of whose
 * midnight it is. The calendar underneath runs in the club's zone and its answer is converted back
 * to the club day it names, so a phone in another zone still picks the day the club means.
 * </p>
 *
 * <p>
 * The trigger reads like the week strip — "Tue 23 Sep" — and is a 44px button. Popover from `sm`
 * up; a bottom Sheet below, where a floating calendar under a thumb is a mis-tap waiting to happen.
 * `min`/`max` disable the days outside the bookable window and stop navigation past it.
 * </p>
 */

export type DatePickerProps = {
  /** The chosen club day, `YYYY-MM-DD`. */
  value: string | null | undefined;
  onChange: (day: string) => void;
  /** Names the trigger and titles the sheet, e.g. "Jump to a date". */
  label: string;
  /** First choosable club day, inclusive. */
  min?: string;
  /** Last choosable club day, inclusive. */
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  /** IANA zone for the calendar's "today". Defaults to the club's. */
  timeZone?: string;
  className?: string;
};

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → [year, monthIndex, day], or null for anything else. */
function partsOf(day: string | null | undefined): [number, number, number] | null {
  const match = day ? DAY_PATTERN.exec(day) : null;
  if (!match) return null;
  return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
}

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

/** "Tue 23 Sep". Pure calendar arithmetic on the day itself — no zone can move it. */
export function formatClubDayLabel(day: string | null | undefined): string | null {
  const parts = partsOf(day);
  if (!parts) return null;
  return format(new Date(parts[0], parts[1], parts[2]), "EEE d MMM");
}

type TriggerProps = React.ComponentProps<"button"> & { text: string | null; placeholder: string; label: string };

function DateTrigger({ text, placeholder, label, className, ...props }: TriggerProps) {
  return (
    <button
      type="button"
      data-slot="date-picker-trigger"
      aria-label={text ? `${label}: ${text}` : label}
      className={cn(
        fieldSurface,
        "inline-flex min-h-touch w-auto items-center gap-2 px-3 font-medium tabular-nums hover:bg-bg-muted",
        className,
      )}
      {...props}
    >
      <CalendarBlank size={16} aria-hidden="true" className="shrink-0 text-text-secondary" />
      <span className={cn(!text && "text-text-muted")}>{text ?? placeholder}</span>
    </button>
  );
}

type PanelProps = Pick<DatePickerProps, "value" | "min" | "max"> & { zone: string | undefined; onPick: (day: string) => void };

function DateCalendar({ value, min, max, zone, onPick }: PanelProps) {
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
      className="mx-auto"
    />
  );
}

function DatePicker(props: DatePickerProps) {
  const {
    value,
    onChange,
    label,
    min,
    max,
    placeholder = "Pick a date",
    disabled,
    timeZone,
    className,
  } = props;
  const [open, setOpen] = React.useState(false);
  const wide = useIsSmUp();
  const zone = timeZone ?? clubZone();
  const pick = (day: string) => {
    onChange(day);
    setOpen(false);
  };
  const trigger = (
    <DateTrigger text={formatClubDayLabel(value)} placeholder={placeholder} label={label} disabled={disabled} className={className} />
  );
  const calendar = <DateCalendar value={value} min={min} max={max} zone={zone} onPick={pick} />;
  if (wide) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" aria-label={label} className="w-auto p-2">
          {calendar}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent aria-describedby={undefined} guardTyped={false}>
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
        </SheetHeader>
        <SheetBody className="pb-4">{calendar}</SheetBody>
      </SheetContent>
    </Sheet>
  );
}

export { DatePicker };
