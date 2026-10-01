import { useId, useState } from "react";
import { Alert } from "../Alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { RadioCard, RadioGroup } from "../ui/radio-group";
import { TimeSelect } from "../ui/time-select";
import { TIME_TRIGGER_FIX } from "./SentenceParts";
import {
  clubDateShort, daysFromLegend, daysPhrase, editScopeOptions, editScopeQuestion, pastNeverChanges, weekdayName,
} from "../../lib/scheduleCopy";
import { WEEKDAYS, type Weekday } from "../../lib/adminApi";
import { parseHhMm } from "../../lib/scheduleRules";

/**
 * D2 §11.5's two operations, as the question a person would actually be asked.
 *
 * <p>
 * <b>Two options, and the third fact stated whether or not anybody asked.</b> "Tuesdays before
 * 13 October never change — what already happened stays as it happened" is the sentence an
 * admin is silently worrying about, and it is true by construction rather than by promise:
 * every re-materialisation query in D2 is `WHERE StartsAt > now()`.
 * </p>
 *
 * <p>
 * <b>D3 §5.4's split-on-edit model is NOT built, by decision.</b> D3 ends the old series and
 * starts a new one linked by `supersedes_plan_id`, which is what a calendar does. D2 §11.5
 * rejects it with a reason worth keeping: it fragments one league night across three rows over
 * a season, and "who changed league night, and when" becomes a join instead of a read. One
 * schedule row plus the append-only change record answers it in one query. So there is no
 * `supersedes_plan_id` here and no "Continues from…" line.
 * </p>
 *
 * <p>
 * <b>The primary button restates the option chosen.</b> The two routes do materially
 * different things — one writes a `BookingScheduleException` for one date, the other rewrites
 * every unstarted row from that date onwards — and a button reading "Save" is the same button
 * for both.
 * </p>
 */

export type EditScope = "only" | "future";

export function OccurrenceChange(props: {
  /** The occurrence this change is anchored on, club-local `YYYY-MM-DD`. */
  date: string;
  /** The rule's current hours, as the starting value. */
  start: string;
  end: string;
  /** The rule's current days — "from this date on" may change them (R5 A5-4). */
  days?: readonly Weekday[];
  busy: boolean;
  /** Rendered above the controls: a refusal, or a notice that the date was clamped. */
  error?: React.ReactNode;
  onCancel: () => void;
  onSubmit: (choice: { scope: EditScope; start: string; end: string; reason: string; days?: Weekday[] }) => void;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { date, start, end, days, busy, error, onCancel, onSubmit } = props;
  const groupId = useId();
  const [scope, setScope] = useState<EditScope>("only");
  const [newStart, setNewStart] = useState(start);
  const [newEnd, setNewEnd] = useState(end);
  const [newDays, setNewDays] = useState<Weekday[]>([...(days ?? [])]);
  const [reason, setReason] = useState("");

  const options = editScopeOptions(date);
  const startMinute = parseHhMm(newStart);
  const endMinute = parseHhMm(newEnd);
  const rangeValid = startMinute !== null && endMinute !== null && endMinute > startMinute;
  // Days change only from a date on: one date moved to another weekday is a different date.
  const daysChanged = scope === "future" && days !== undefined && !sameDays(newDays, days);
  const daysValid = scope === "only" || newDays.length > 0;
  const chosen = scope === "only" ? options.only : options.future;
  // "Change just Tue 13 Oct to 19:00–21:30" — the whole action in the label, so the last
  // thing read before the press is what will happen.
  const to = daysChanged ? `${daysPhrase(newDays)}, ${newStart}–${newEnd}` : `${newStart}–${newEnd}`;
  const submitLabel = `Change ${scope === "only" ? `just ${clubDateShort(date)}` : chosen} to ${to}`;
  const toggleDay = (day: Weekday, on: boolean) =>
    setNewDays((was) => (on ? WEEKDAYS.filter((d) => d === day || was.includes(d)) : was.filter((d) => d !== day)));

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-muted p-4">
      {error}

      <div className="flex flex-col gap-2">
        <p id={`${groupId}-question`} className="text-sm font-semibold text-text-primary">
          {editScopeQuestion(date)}
        </p>
        <RadioGroup
          aria-labelledby={`${groupId}-question`}
          value={scope}
          onValueChange={(next) => setScope(next as EditScope)}
          className="grid gap-2 sm:grid-cols-2"
        >
          <RadioCard value="only" title={options.only} />
          <RadioCard value="future" title={options.future} />
        </RadioGroup>
        {/* Said with the choice, not below the fold: it is the fact the choice is about. */}
        <p className="text-sm text-text-secondary">{pastNeverChanges(date)}</p>
      </div>

      {scope === "future" && days !== undefined && (
        <fieldset className="flex flex-col gap-2">
          {/* The fieldset is the group, named by its legend. */}
          <legend className="text-sm font-semibold text-text-primary">{daysFromLegend(date)}</legend>
          <div className="flex flex-wrap gap-x-4">
            {WEEKDAYS.map((day) => (
              <label key={day} className="flex min-h-touch cursor-pointer items-center gap-2 text-sm text-text-primary">
                <Checkbox checked={newDays.includes(day)} onCheckedChange={(next) => toggleDay(day, next === true)} />
                {weekdayName(day)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {/* Slice-aligned times only (P3, R7 — never free-typed). */}
      <div className="flex flex-wrap gap-4">
        <Field className="w-40">
          <FieldLabel>New start time</FieldLabel>
          <TimeSelect start={DAY_START} end={DAY_END} stepMinutes={STEP} value={newStart} onChange={setNewStart} className={TIME_TRIGGER_FIX} />
        </Field>
        <Field className="w-40">
          <FieldLabel>New end time</FieldLabel>
          <TimeSelect start={DAY_START} end={DAY_END} stepMinutes={STEP} includeEnd value={newEnd} onChange={setNewEnd} className={TIME_TRIGGER_FIX} />
        </Field>
      </div>

      {!daysValid && (
        <Alert tone="warning" live="polite" announceKey="occurrence-days">
          Choose at least one day.
        </Alert>
      )}

      {!rangeValid && (
        <Alert tone="warning" live="polite" announceKey="occurrence-range">
          The end time has to be after the start time, on the same day.
        </Alert>
      )}

      <Field>
        <FieldLabel>Reason (kept in the change record)</FieldLabel>
        <Input value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button
          disabled={(!rangeValid || !daysValid) && !busy}
          pending={busy}
          onClick={() => onSubmit({
            scope, start: newStart, end: newEnd, reason: reason.trim(), ...(daysChanged ? { days: newDays } : {}),
          })}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * The times a date can be moved to. This page reads no club settings, and its own slot count
 * already assumes the 15-minute slice (`slotsPerOccurrence(…, 15)` in the detail page); the
 * server is what refuses a time the club's own slice cannot book.
 */
const DAY_START = "05:00";
const DAY_END = "24:00";
const STEP = 15;

function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  return a.length === b.length && a.every((d) => b.includes(d));
}
