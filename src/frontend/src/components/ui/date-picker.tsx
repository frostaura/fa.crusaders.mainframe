import * as React from "react";
import { CalendarBlank } from "@/components/ui/icons";
import { fieldSurface } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { keepFiguresWhole } from "@/components/ui/figure-text";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useIsSmUp } from "@/components/ui/use-media-query";
import { clubZone } from "@/lib/clubZone";
import { cn } from "@/lib/utils";
import { formatClubDayLabel } from "@/components/ui/date-picker-day";
import { Skeleton } from "@/components/ui/skeleton";

const loadCalendar = () => import("@/components/ui/date-picker-calendar");
const DateCalendar = React.lazy(loadCalendar);

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

type TriggerProps = React.ComponentProps<"button"> & { text: string | null; placeholder: string; label: string };

function DateTrigger({ text, placeholder, label, className, ...props }: TriggerProps) {
  return (
    <button
      type="button"
      data-slot="date-picker-trigger"
      aria-label={text ? `${label}: ${text}` : label}
      className={cn(
        fieldSurface,
        "inline-flex min-h-touch w-auto max-w-full items-center gap-[min(0.5rem,8px)] px-[min(0.75rem,12px)] font-medium tabular-nums hover:bg-bg-muted",
        className,
      )}
      {...props}
    >
      {/* R7 L6-16 — 16px at 100 % text, growing with it. */}
      <CalendarBlank size="1rem" aria-hidden="true" className="shrink-0 text-text-secondary" />
      {/* R11: "Sat 3 / Oct" split the day from its month at 200 % text; "Sat / 3 Oct" may wrap.
          The trigger's aria-label carries the plain spelling. */}
      <span className={cn(!text && "text-text-muted")}>{text ? keepFiguresWhole(text) : placeholder}</span>
    </button>
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
    <DateTrigger
      text={formatClubDayLabel(value)} placeholder={placeholder} label={label} disabled={disabled} className={className}
      // Start fetching the calendar the moment a pointer or focus arrives, not on the tap.
      onPointerEnter={() => void loadCalendar()} onFocus={() => void loadCalendar()}
    />
  );
  // Lazy (see date-picker-calendar.tsx); the fallback holds the calendar's footprint so the
  // popover or sheet does not jump when it arrives.
  const calendar = (
    <React.Suspense fallback={<Skeleton aria-hidden="true" className="mx-auto h-72 w-full max-w-xs" />}>
      <DateCalendar value={value} min={min} max={max} zone={zone} onPick={pick} />
    </React.Suspense>
  );
  if (wide) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent align="start" aria-label={label} className="w-80 p-2">
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
