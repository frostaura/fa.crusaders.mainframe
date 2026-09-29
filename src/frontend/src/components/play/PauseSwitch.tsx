import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Pause as PauseIcon, WarningCircle } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { playEndpoints, type Pause } from "@/lib/playApi";
import { PAUSE_COPY, playRefusal } from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";

/**
 * The injury pause (§5.3, §9.1.2): on from the current club week, never backwards, within a
 * yearly allowance. The switch saves the moment it is flipped — the member's own setting, not a
 * form — and a refusal puts it back with the reason said beside it.
 *
 * <p>
 * <b>Past the allowance the pause stays on</b> (the member may still be injured) and the card
 * says plainly that this week counts; with the allowance used and the pause off, the switch is
 * not offered, because the only thing turning it on could do is be refused.
 * </p>
 */
export function PauseSwitch({ pause, year, onChanged }: { pause: Pause; year: number; onChanged: (pause: Pause) => void }) {
  const toggle = useAsyncAction((on: boolean) => (on ? playEndpoints.startPause() : playEndpoints.endPause()), {
    success: (answer) => onChanged(answer),
  });
  const left = Math.max(0, pause.weeks_per_year - pause.weeks_used_this_year);
  const off = pause.weeks_per_year === 0;
  const usedUp = left === 0 && !off;
  const unavailable = off || (usedUp && !pause.active);
  return (
    <div data-pause={pause.active ? "on" : "off"} className="flex flex-col gap-2 border-t border-border pt-4">
      <Field className="grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <FieldLabel className="inline-flex items-center gap-1.5">
            <PauseIcon size={16} aria-hidden="true" />
            {PAUSE_COPY.label}
          </FieldLabel>
          <FieldDescription className="break-words">{hint(pause, left, year)}</FieldDescription>
        </div>
        <div className="col-start-2 row-span-full flex min-h-touch items-center gap-2">
          {toggle.pending ? <Spinner className="text-text-secondary" label={PAUSE_COPY.label} /> : null}
          <Switch
            checked={pause.active}
            disabled={unavailable}
            aria-busy={toggle.pending || undefined}
            onCheckedChange={(next) => { if (!toggle.pending) void toggle.run(next); }}
          />
        </div>
      </Field>
      {toggle.error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger-strong">
          <WarningCircle size={16} weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{playRefusal(toggle.error, PAUSE_COPY.action)}</span>
        </p>
      ) : null}
    </div>
  );
}

function hint(pause: Pause, left: number, year: number): string {
  if (pause.weeks_per_year === 0) return PAUSE_COPY.off;
  if (left === 0) return PAUSE_COPY.usedUp(pause.weeks_per_year, year);
  return PAUSE_COPY.hint(left, pause.weeks_per_year, year);
}
