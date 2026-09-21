import { useId, useState } from "react";
import { Alert } from "../Alert";
import { Button, Input, Label } from "../Button";
import {
  clubDateShort, editScopeOptions, editScopeQuestion, pastNeverChanges,
} from "../../lib/scheduleCopy";
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

export function OccurrenceChange({
  date, start, end, busy, error, onCancel, onSubmit,
}: {
  /** The occurrence this change is anchored on, club-local `YYYY-MM-DD`. */
  date: string;
  /** The rule's current hours, as the starting value. */
  start: string;
  end: string;
  busy: boolean;
  /** Rendered above the controls: a refusal, or a notice that the date was clamped. */
  error?: React.ReactNode;
  onCancel: () => void;
  onSubmit: (choice: { scope: EditScope; start: string; end: string; reason: string }) => void;
}) {
  const groupId = useId();
  const [scope, setScope] = useState<EditScope>("only");
  const [newStart, setNewStart] = useState(start);
  const [newEnd, setNewEnd] = useState(end);
  const [reason, setReason] = useState("");

  const options = editScopeOptions(date);
  const startMinute = parseHhMm(newStart);
  const endMinute = parseHhMm(newEnd);
  const rangeValid = startMinute !== null && endMinute !== null && endMinute > startMinute;
  const chosen = scope === "only" ? options.only : options.future;
  // "Change just Tue 13 Oct to 19:00–21:30" — the whole action in the label, so the last
  // thing read before the press is what will happen.
  const submitLabel = `Change ${scope === "only" ? `just ${clubDateShort(date)}` : chosen} to ${newStart}–${newEnd}`;

  return (
    <div className="space-y-4 rounded-lg border border-border bg-bg-muted p-4">
      {error}

      <div role="radiogroup" aria-labelledby={`${groupId}-question`} className="space-y-2">
        <p id={`${groupId}-question`} className="text-sm font-semibold text-text-primary">
          {editScopeQuestion(date)}
        </p>
        {(["only", "future"] as const).map((value) => (
          <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input
              type="radio"
              name={`${groupId}-scope`}
              value={value}
              checked={scope === value}
              onChange={() => setScope(value)}
              className="h-5 w-5 accent-accent-strong"
            />
            {value === "only" ? options.only : options.future}
          </label>
        ))}
        {/* Said in the radiogroup, not below the fold: it is the fact the choice is about. */}
        <p className="text-sm text-text-secondary">{pastNeverChanges(date)}</p>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="space-y-1">
          <Label htmlFor={`${groupId}-start`}>New start time</Label>
          <Input
            id={`${groupId}-start`}
            type="time"
            value={newStart}
            onChange={(e) => setNewStart(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${groupId}-end`}>New end time</Label>
          <Input
            id={`${groupId}-end`}
            type="time"
            value={newEnd}
            onChange={(e) => setNewEnd(e.target.value)}
          />
        </div>
      </div>

      {!rangeValid && (
        <Alert tone="warning" live="polite" announceKey="occurrence-range">
          The end time has to be after the start time, on the same day.
        </Alert>
      )}

      <div className="space-y-1">
        <Label htmlFor={`${groupId}-reason`}>Reason (kept in the change record)</Label>
        <Input
          id={`${groupId}-reason`}
          value={reason}
          maxLength={512}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={onCancel}>Keep it as it is</Button>
        <Button
          className="min-h-11"
          disabled={!rangeValid || busy}
          loading={busy}
          onClick={() => onSubmit({ scope, start: newStart, end: newEnd, reason: reason.trim() })}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
