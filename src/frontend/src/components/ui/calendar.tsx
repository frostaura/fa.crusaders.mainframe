import * as React from "react";
import { DayPicker, type ChevronProps, type DayButtonProps } from "react-day-picker";
import { enGB } from "react-day-picker/locale";
import { CaretDown, CaretLeft, CaretRight, CaretUp } from "@/components/ui/icons";
import { clubZone } from "@/lib/clubZone";
import { cn } from "@/lib/utils";

/**
 * Calendar — react-day-picker v10, styled with our tokens (design-system.md: calendar).
 *
 * <p>
 * <b>The club's calendar, not the reader's.</b> `timeZone` defaults to the zone the club last told
 * us (`lib/clubZone`), so "today", the disabled range and the date a tap emits are the club's
 * day wherever the phone is. With a zone set, DayPicker hands back a `TZDate` at the start of that
 * day in the zone — format it with `date-fns` (its getters answer in the zone) or pass it to
 * `clubDayOf`. Weeks start on Monday.
 * </p>
 *
 * <p>
 * Day buttons are squares that fill their column up to 56px (R4 X4-3), carry `data-slot="calendar-day"` so
 * the lift rule in `index.css` exempts them (a day is chosen, not pressed), and mark today with an
 * accent edge and the selection with the primary fill — never colour alone: today is also bold.
 * </p>
 */

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

const NAV_BUTTON = cn(
  "inline-flex size-touch items-center justify-center rounded-lg border border-transparent text-text-secondary",
  "transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary",
  "aria-disabled:pointer-events-none aria-disabled:opacity-40 motion-reduce:transition-none",
);

/*
 * R4 X4-3 — the month is a fluid seven-column grid, not seven fixed 44px cells: at 320px the
 * sheet had 288px for 308px of days, so Sunday and "next month" sat off-screen and the dialog
 * scrolled sideways; at 390px with 200% text a rem-sized cell was 88px and the month 616px wide.
 * Each day is a square that takes its column's width, up to 56px (a 44px target wherever there
 * is room for one). The popover gives the calendar its width (`date-picker`), the sheet its own.
 */
const CLASS_NAMES: CalendarProps["classNames"] = {
  root: "w-full",
  months: "relative flex flex-col gap-4",
  month: "flex flex-col gap-2",
  nav: "absolute inset-x-0 top-0 flex items-center justify-between",
  button_previous: NAV_BUTTON,
  button_next: NAV_BUTTON,
  month_caption: "flex min-h-touch items-center justify-center px-12 text-center",
  caption_label: "text-sm font-semibold leading-tight text-text-primary",
  month_grid: "grid w-full",
  weekdays: "grid grid-cols-7",
  weekday: "pb-1 text-center text-xs font-medium text-text-muted",
  weeks: "grid",
  week: "grid grid-cols-7",
  day: "flex justify-center p-0 text-center",
  day_button: "",
  outside: "text-text-muted",
  hidden: "invisible",
};

const DAY_BUTTON = cn(
  "no-lift inline-flex aspect-square w-full max-w-14 items-center justify-center rounded-lg border border-transparent text-sm tabular-nums",
  "text-text-primary transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none",
  "data-[today=true]:border-accent-strong data-[today=true]:font-bold",
  "data-[outside=true]:text-text-muted",
  "data-[selected=true]:bg-primary data-[selected=true]:text-primary-ink data-[selected=true]:hover:bg-primary-hover",
  "disabled:cursor-not-allowed disabled:text-text-muted disabled:line-through disabled:hover:bg-transparent",
);

/**
 * One day. Keeps DayPicker's roving focus (it focuses the button whose day is `focused`) and adds
 * the data attributes our classes key on.
 */
function CalendarDayButton({ day, modifiers, className, ...props }: DayButtonProps) {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  return (
    <button
      ref={ref}
      data-slot="calendar-day"
      data-day={day.isoDate}
      data-today={modifiers.today || undefined}
      data-selected={modifiers.selected || undefined}
      data-outside={day.outside || undefined}
      className={cn(DAY_BUTTON, className)}
      {...props}
    />
  );
}

const CHEVRONS = { left: CaretLeft, right: CaretRight, up: CaretUp, down: CaretDown };

function CalendarChevron({ orientation = "left", className }: ChevronProps) {
  const Icon = CHEVRONS[orientation];
  return <Icon size={20} aria-hidden="true" className={className} />;
}

function Calendar({
  className,
  classNames,
  components,
  timeZone = clubZone(),
  weekStartsOn = 1,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      data-slot="calendar"
      locale={enGB}
      timeZone={timeZone}
      weekStartsOn={weekStartsOn}
      showOutsideDays={showOutsideDays}
      className={cn("p-2", className)}
      classNames={{ ...CLASS_NAMES, ...classNames }}
      components={{ DayButton: CalendarDayButton, Chevron: CalendarChevron, ...components }}
      {...props}
    />
  );
}

export { Calendar };
