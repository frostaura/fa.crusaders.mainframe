import { useState, type ReactNode } from "react";
import { ToggleGroup } from "radix-ui";
import { cn } from "@/lib/utils";
import { CaretLeft, CaretRight } from "./icons";
import { SCALING_ICON } from "./layout";
import { dateTimeFormat } from "@/lib/intlCache";

/**
 * The day picker for the booking grid (design-system.md, Patterns → Day picker): one week of
 * day chips, prev/next week, and a trailing slot for the calendar button that opens the
 * `DatePicker` to jump further.
 *
 * <p>
 * <b>Dates are calendar dates, never instants.</b> Every value is a `YYYY-MM-DD` string and all
 * arithmetic is done at UTC midnight, so a DST change, a device in another zone or the runner's
 * `TZ` can never move a chip by a day. The club's zone matters only for knowing which date is
 * TODAY — pass `today` (preferred, from the club clock) or `timeZone` to derive it.
 * </p>
 *
 * <p>
 * <b>Moving a week moves the selection.</b> The visible week is always the week of `value`;
 * prev/next select the same weekday a week away, clamped into the window. One source of truth,
 * so the strip can never show a week the grid below is not showing.
 * </p>
 *
 * <p>
 * Radix ToggleGroup, `type="single"`: arrow keys rove, Space/Enter select, and a second press
 * on the selected chip does not clear it. No watermark (the spec's "Never" list); `no-lift`
 * because a selectable chip is chosen, not pressed.
 * </p>
 */
export type WeekStripProps = {
  /** The selected date, `YYYY-MM-DD`. */
  value: string;
  onChange: (date: string) => void;
  /** The first and last selectable dates — the booking window. */
  min: string;
  max: string;
  /** The club's today, `YYYY-MM-DD`. Derived from `timeZone` when omitted. */
  today?: string;
  /** IANA zone used ONLY to derive `today` when it is not passed. */
  timeZone?: string;
  /** Dates carrying a dot — "you have a booking". */
  markedDays?: ReadonlySet<string>;
  /** What a dot means, appended to the chip's accessible name. */
  markedLabel?: string;
  /** Mute and disable days before today (members). Admins may book into the past. */
  disablePast?: boolean;
  /** 0 = Sunday … 6 = Saturday. Monday by default. */
  weekStartsOn?: number;
  /** Beside prev/next: the calendar button. */
  trailing?: ReactNode;
  /** The group's accessible name. */
  label?: string;
  className?: string;
};

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function startOfWeek(date: string, weekStartsOn: number): string {
  const weekday = new Date(toUtc(date)).getUTCDay();
  return addDays(date, -((weekday - weekStartsOn + 7) % 7));
}

function clamp(date: string, low: string, high: string): string {
  if (date < low) return low;
  return date > high ? high : date;
}

function todayIn(timeZone?: string): string {
  const parts = dateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return parts.format(new Date());
}

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" });
const WEEKDAY_SHORT = format({ weekday: "short" });
const DAY_NAME = format({ weekday: "long", day: "numeric", month: "long" });
const MONTHS = {
  long: { month: format({ month: "long" }), monthYear: format({ month: "long", year: "numeric" }) },
  short: { month: format({ month: "short" }), monthYear: format({ month: "short", year: "numeric" }) },
};

/**
 * "September 2026", or "September – October 2026" for a week that spans two; "Sep – Oct 2026"
 * in the short form a phone gets (R2 F1-10: at twice the text size "September" did not fit
 * beside the week arrows and broke mid-word).
 */
function monthLabel(first: string, last: string, form: keyof typeof MONTHS = "long"): string {
  const { month, monthYear } = MONTHS[form];
  const [a, b] = [new Date(toUtc(first)), new Date(toUtc(last))];
  if (a.getUTCMonth() === b.getUTCMonth()) return monthYear.format(a);
  const lead = a.getUTCFullYear() === b.getUTCFullYear() ? month.format(a) : monthYear.format(a);
  return `${lead} – ${monthYear.format(b)}`;
}

type Day = { date: string; disabled: boolean; past: boolean; today: boolean; marked: boolean };

type Window = { floor: string; max: string; today: string; marked?: ReadonlySet<string> };

function dayOf(date: string, w: Window): Day {
  // Comparisons hoisted out of the object literal: lizard's .tsx lexer reads a bare `<` inside
  // one as a JSX tag and mis-scopes the rest of the file (memory/gotchas-gates.md).
  const outside = date < w.floor || date > w.max;
  const past = date < w.today;
  const marked = w.marked?.has(date) ?? false;
  return { date, disabled: outside, past, today: date === w.today, marked };
}

function buildWeek(start: string, w: Window): Day[] {
  return Array.from({ length: 7 }, (_, i) => dayOf(addDays(start, i), w));
}

function chipName(day: Day, markedLabel: string): string {
  const parts = [DAY_NAME.format(new Date(toUtc(day.date)))];
  if (day.today) parts.push("today");
  if (day.marked) parts.push(markedLabel);
  return parts.join(", ");
}

/**
 * R2 F1-11 — forced colours (Windows High Contrast). The mode throws the fills away, so the
 * selected day read like every other and the disabled past, drawn in the system's GrayText,
 * read as highlighted. The chip opts out of the override and draws in system colours only:
 * the selected day in Highlight, every other day in ButtonText with a border, the past with a
 * dashed GrayText edge (still a visible edge — the gallery's forced-colours check), and today's
 * ring in CanvasText.
 */
const FORCED = cn(
  "forced-colors:[forced-color-adjust:none] forced-colors:border-[ButtonText] forced-colors:bg-[ButtonFace] forced-colors:text-[ButtonText]",
  "forced-colors:data-[state=on]:border-[Highlight] forced-colors:data-[state=on]:bg-[Highlight] forced-colors:data-[state=on]:text-[HighlightText]",
  "forced-colors:disabled:border-dashed forced-colors:disabled:border-[GrayText] forced-colors:disabled:text-[GrayText]",
  "forced-colors:ring-[CanvasText]",
);

const CHIP = cn(
  "group no-lift relative flex h-14 min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg",
  "border border-transparent text-text-primary transition-colors duration-fast ease-standard",
  "hover:bg-bg-muted disabled:hover:bg-transparent",
  "data-[state=on]:bg-primary data-[state=on]:text-primary-ink data-[state=on]:hover:bg-primary-hover",
  FORCED,
);

function DayChip({ day, markedLabel, mutePast }: { day: Day; markedLabel: string; mutePast: boolean }) {
  return (
    <ToggleGroup.Item
      value={day.date}
      disabled={day.disabled}
      aria-disabled={day.disabled || undefined}
      aria-label={chipName(day, markedLabel)}
      data-date={day.date}
      data-today={day.today || undefined}
      data-past={day.past || undefined}
      className={cn(
        CHIP,
        day.today && "ring-2 ring-inset ring-accent-strong",
        (day.disabled || (mutePast && day.past)) && "text-text-muted",
      )}
    >
      <span className="text-xs font-medium">{WEEKDAY_SHORT.format(new Date(toUtc(day.date)))}</span>
      <span className="text-lg font-semibold leading-none tabular-nums">{Number(day.date.slice(8))}</span>
      {day.marked ? (
        <span
          aria-hidden="true"
          data-marked-dot=""
          className="absolute bottom-1 size-1.5 rounded-full bg-accent-strong group-data-[state=on]:bg-primary-ink"
        />
      ) : null}
    </ToggleGroup.Item>
  );
}

type NavProps = { direction: "prev" | "next"; blocked: boolean; onGo: () => void };

function WeekNav({ direction, blocked, onGo }: NavProps) {
  const Icon = direction === "prev" ? CaretLeft : CaretRight;
  return (
    <button
      type="button"
      aria-label={direction === "prev" ? "Previous week" : "Next week"}
      aria-disabled={blocked || undefined}
      onClick={() => { if (!blocked) onGo(); }}
      className={cn(
        "no-lift inline-flex size-touch shrink-0 items-center justify-center rounded-lg border border-transparent",
        "text-text-secondary transition-colors duration-fast ease-standard hover:bg-bg-muted hover:text-text-primary",
        "aria-disabled:text-text-muted aria-disabled:hover:bg-transparent",
      )}
    >
      {/* R7 L6-16 — 20px at 100 % text, growing with it (the target is 44px, and the glyph fits it). */}
      <Icon size={SCALING_ICON} aria-hidden="true" />
    </button>
  );
}

export function WeekStrip(props: WeekStripProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const {
    value, onChange, min, max, today, timeZone, markedDays, markedLabel = "you have a booking",
    disablePast = false, weekStartsOn = 1, trailing, label = "Choose a day", className,
  } = props;
  const [derivedToday] = useState(() => todayIn(timeZone));
  const now = today ?? derivedToday;
  const floor = disablePast && now > min ? now : min;
  const start = startOfWeek(value, weekStartsOn);
  const end = addDays(start, 6);
  const days = buildWeek(start, { floor, max, today: now, marked: markedDays });
  const go = (weeks: number) => onChange(clamp(addDays(value, weeks * 7), floor, max));

  return (
    <div data-week-strip="" className={cn("flex flex-col gap-2", className)}>
      {/* R5 X5-11 — wraps as a ROW at large text: the caption takes its own line and the arrows
          and calendar follow on the right, instead of "Sept / – / Oct / 2026" a word a line. */}
      <div className="flex flex-wrap items-center gap-1">
        {/* Wraps rather than truncating (F1.16): at twice the text size "September – October
            2026" was cut to "Septem…", the one line saying which month the chips are in. */}
        {/* R2 F1-10: words wrap whole, never mid-letter ("Septemb/er"); a phone gets the short
            months so each word fits beside the arrows. The long form from `sm` up. */}
        <p data-month="" className="min-w-0 flex-1 basis-32 text-sm font-semibold text-text-primary">
          <span className="sm:hidden">{monthLabel(start, end, "short")}</span>
          <span className="hidden sm:inline">{monthLabel(start, end)}</span>
        </p>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <WeekNav direction="prev" blocked={start <= floor} onGo={() => go(-1)} />
          <WeekNav direction="next" blocked={end >= max} onGo={() => go(1)} />
          {trailing}
        </span>
      </div>
      <ToggleGroup.Root
        type="single"
        value={value}
        onValueChange={(next) => { if (next) onChange(next); }}
        aria-label={label}
        // F1.16 — as many chips per row as fit whole, never seven squeezed into a row they
        // overflow: at 200% text on a 390px phone the chips overlapped.
        // R17 X17-3 — each chip is a 44px target (2.75rem), and seven still fit a 320px phone: a
        // row narrower than seven of them (310px) reaches up to 12px into the page's 16px gutters,
        // and the gap between chips is only what is left over, up to 2px (the chips have no fill
        // at rest). A width, not a breakpoint: `min-[…]` is not emitted with these mixed-unit screens.
        className={cn(
          "grid grid-cols-[repeat(auto-fit,minmax(2.75rem,1fr))] gap-y-0.5",
          "mx-[clamp(-12px,calc((100%_-_310px)_/_2),0px)] gap-x-[clamp(0px,calc((100%_-_310px)_/_6),2px)] sm:gap-1",
        )}
      >
        {days.map((day) => (
          <DayChip key={day.date} day={day} markedLabel={markedLabel} mutePast={disablePast} />
        ))}
      </ToggleGroup.Root>
    </div>
  );
}
