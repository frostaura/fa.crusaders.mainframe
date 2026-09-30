import { useState } from "react";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { playEndpoints, type PlaySettings } from "@/lib/playApi";
import { GOAL_SHEET, playRefusal, readGoal } from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";

/**
 * Setting the monthly goal (§9.1.1): hours, in quarter hours, 0.5–100 — the server's 30–6000
 * minutes in steps of 15 (§6.2) — and `Remove goal`, which takes the ring away altogether.
 *
 * <p>
 * The typed hours are checked with the server's own bound before the button does anything, and
 * a `goal_out_of_range` that comes back anyway says the same sentence.
 * </p>
 */
export type GoalSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goalMinutes: number | null;
  onSaved: (settings: PlaySettings, removed: boolean) => void;
};

export function GoalSheet(props: GoalSheetProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <GoalBody {...props} /> : null}
    </Dialog>
  );
}

function hoursText(minutes: number | null): string {
  if (minutes === null) return "";
  return String(Math.round((minutes / 60) * 100) / 100);
}

function GoalBody(props: GoalSheetProps) {
  const { goalMinutes, onSaved } = props;
  const [text, setText] = useState(hoursText(goalMinutes));
  const [tried, setTried] = useState(false);
  const goal = readGoal(text);
  const save = useAsyncAction((goal: number) => playEndpoints.saveSettings({ monthlyGoalMinutes: goal }), {
    success: (settings) => onSaved(settings, false),
  });
  const remove = useAsyncAction(() => playEndpoints.saveSettings({ monthlyGoalMinutes: null }), {
    success: (settings) => onSaved(settings, true),
  });
  const error = save.error ?? remove.error;
  const invalid = tried && !goal.ok;
  const submit = () => {
    setTried(true);
    if (goal.ok) void save.run(goal.minutes);
  };
  return (
    <DialogContent data-dialog="goal-sheet">
      <DialogHeader>
        <DialogTitle>{GOAL_SHEET.title}</DialogTitle>
        <DialogDescription>{GOAL_SHEET.description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <form noValidate id="goal-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field controlId="goal-hours" invalid={invalid}>
            <FieldLabel>{GOAL_SHEET.label}</FieldLabel>
            <Input
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-32 tabular-nums"
            />
            {!goal.ok && invalid ? <FieldError>{goal.sentence}</FieldError> : <FieldDescription>{GOAL_SHEET.hint}</FieldDescription>}
          </Field>
        </form>
        {error ? <Alert tone="danger" live="assertive">{playRefusal(error, GOAL_SHEET.action)}</Alert> : null}
      </DialogBody>
      <DialogFooter>
        {goalMinutes !== null ? (
          <Button variant="ghost" className="sm:mr-auto" pending={remove.pending} onClick={() => void remove.run()}>{GOAL_SHEET.remove}</Button>
        ) : null}
        <Button variant="outline" onClick={() => props.onOpenChange(false)}>{GOAL_SHEET.cancel}</Button>
        <Button type="submit" form="goal-form" pending={save.pending}>{GOAL_SHEET.save}</Button>
      </DialogFooter>
    </DialogContent>
  );
}
