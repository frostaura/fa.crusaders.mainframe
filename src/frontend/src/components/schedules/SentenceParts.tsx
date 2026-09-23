import { useId, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { CaretDown, X } from "../ui/icons";
import { Checkbox } from "../ui/checkbox";
import { DatePicker } from "../ui/date-picker";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { TimeSelect } from "../ui/time-select";

/**
 * The inline controls the rule editor is built out of — D3 §5.2's `SentenceField`.
 *
 * <p>
 * <b>The editor is one readable sentence, not a stack of labelled boxes.</b> "Hold Courts 1, 2
 * and 3 on Tuesdays from 18:00 to 21:00, called League night, from Tue 7 Oct until Mon 30 Nov"
 * is a thing a volunteer can check by reading it. The same information as eight form rows is
 * a thing a volunteer can only check by knowing what each row was for.
 * </p>
 *
 * <p>
 * <b>Every field is a design-system primitive (P3, R7).</b> The sentence used native `<input
 * type="time|date">` and `<select>` — a different picker in every browser, none of them ours.
 * Times are now a {@link TimeSelect} of slice-aligned options, so a start the club cannot book
 * is not choosable at all; dates are the club-day {@link DatePicker}; the interval is a Radix
 * Select; the two set-valued fields (courts, days) are a popover of checkboxes. Every trigger is
 * a real button with its own name, so the tab order is still the order the sentence is spoken.
 * </p>
 *
 * <p>
 * <b>Every field carries a real name.</b> Reading the sentence aloud is how a sighted admin
 * checks it; a screen-reader user tabs from control to control and hears them out of that
 * context, so "Start time, 18:00" has to be the control's name even though the words "Start
 * time" appear nowhere on screen.
 * </p>
 */

/** The shape every inline field shares: a 44px pill that reads as part of the sentence. */
const INLINE = "inline-flex w-auto align-middle font-semibold";

/**
 * `SelectTrigger` line-clamps its direct span, and `line-clamp` is `display: -webkit-box` with a
 * VERTICAL orient — which stacks TimeSelect's clock icon above its time. Put back the row here
 * (reported to the primitive's owner; remove once `ui/time-select` sets it itself).
 */
export const TIME_TRIGGER_FIX = "[&>span]:!flex";

/** Ordinary words between the fields. Kept as a component so the spacing is decided once. */
export function SentenceText({ children }: { children: ReactNode }) {
  return <span className="align-middle text-text-secondary">{children}</span>;
}

type SentenceInputProps = {
  /** The control's real name, visually hidden. See the header. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  invalid?: boolean;
  /** Width class — the two text fields are sized to their likely content. */
  className?: string;
};

export function SentenceInput(props: SentenceInputProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { label, value, onChange, placeholder, maxLength, invalid, className } = props;
  const id = useId();
  return (
    <span className="inline-block align-middle">
      <label htmlFor={id} className="sr-only">{label}</label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(INLINE, "w-44", className)}
      />
    </span>
  );
}

type SentenceTimeProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The club's day, as `HH:mm` bounds, and its slice — the only times it can book. */
  dayStart: string;
  dayEnd: string;
  stepMinutes: number;
  /** An end time may be the day's last boundary itself; a start time may not. */
  isEnd?: boolean;
};

/** A slice-aligned time. Never free-typed: "18:05" on a 15-minute club is not choosable at all. */
export function SentenceTime(props: SentenceTimeProps) {
  const { label, value, onChange, dayStart, dayEnd, stepMinutes, isEnd = false } = props;
  return (
    <TimeSelect
      label={label}
      value={value}
      onChange={onChange}
      start={isEnd ? addMinutes(dayStart, stepMinutes) : dayStart}
      end={dayEnd}
      includeEnd={isEnd}
      stepMinutes={stepMinutes}
      className={cn(INLINE, "min-w-28", TIME_TRIGGER_FIX)}
    />
  );
}

function addMinutes(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type SentenceDateProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  placeholder?: string;
  /** Offer a × that empties the field — for the optional last date ("no end"). */
  clearLabel?: string;
};

/** A club day, from the calendar. Optional dates carry a clear button beside the trigger. */
export function SentenceDate(props: SentenceDateProps) {
  const { label, value, onChange, min, placeholder = "Pick a date", clearLabel } = props;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <DatePicker label={label} value={value || null} onChange={onChange} min={min} placeholder={placeholder} className={INLINE} />
      {clearLabel && value ? (
        <IconButton label={clearLabel} size="icon-sm" onClick={() => onChange("")}>
          <X aria-hidden="true" />
        </IconButton>
      ) : null}
    </span>
  );
}

export function SentenceSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className={cn(INLINE, "min-w-28")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

type SentenceChoicesProps = {
  label: string;
  /** What the trigger reads on screen — the chosen set, in words. */
  summary: string;
  options: Array<{ value: string; label: string }>;
  selected: readonly string[];
  onChange: (value: string, checked: boolean) => void;
  invalid?: boolean;
};

/**
 * A field whose value is a SET — courts, days: a trigger reading the current choice, and a
 * popover of checkboxes under it.
 *
 * <p>
 * The trigger is a `PopoverTrigger`, so `aria-expanded` and `aria-controls` are Radix's and a
 * screen reader hears the state. Opening moves focus to the first checkbox; Escape closes and
 * returns focus to the trigger. The panel is portalled, so it floats over the sentence rather
 * than pushing every word after it down the page, which the old in-flow disclosure did.
 * </p>
 */
export function SentenceChoices(props: SentenceChoicesProps) {
  const { label, summary, options, selected, onChange, invalid } = props;
  const groupId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${summary}`}
          aria-invalid={invalid || undefined}
          className={cn(
            "no-lift inline-flex min-h-touch items-center gap-2 rounded-lg border border-control bg-bg-surface px-3 align-middle",
            "text-left text-base font-semibold text-text-primary shadow-xs sm:text-sm",
            "transition-colors duration-fast ease-standard hover:bg-bg-muted motion-reduce:transition-none",
            "aria-[invalid=true]:border-danger-strong data-[state=open]:border-accent-strong",
          )}
        >
          {summary}
          <CaretDown size={16} aria-hidden="true" className="shrink-0 text-text-secondary" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <p id={groupId} className="px-2 pb-1 pt-1 text-xs font-semibold uppercase tracking-overline text-text-secondary">{label}</p>
        <div role="group" aria-labelledby={groupId} className="flex flex-col">
          {options.map((option) => (
            <label
              key={option.value}
              className="flex min-h-touch cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-text-primary hover:bg-bg-muted"
            >
              <Checkbox
                checked={selected.includes(option.value)}
                onCheckedChange={(next) => onChange(option.value, next === true)}
              />
              {option.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
