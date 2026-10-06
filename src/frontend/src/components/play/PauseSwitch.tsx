import { useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Pause as PauseIcon, WarningCircle } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { playEndpoints, type Pause } from "@/lib/playApi";
import { PAUSE_COPY, PLAY_SETTINGS_UNSURE, playRefusal } from "@/lib/playCopy";
import { useAsyncAction } from "@/lib/useAsyncAction";
import { myPlayWrite } from "./resultReadBack";

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
  // R18 X18-4 — optimistic, like the star and the privacy switches: the switch turns the moment it
  // is flipped and turns back (with the reason said beside it) if the club says no.
  const [flipped, setFlipped] = useState<boolean | null>(null);
  // Lost-reply audit (R3): a lost reply is read back off My game before anything is said.
  const toggle = useAsyncAction(
    (on: boolean) => myPlayWrite(() => (on ? playEndpoints.startPause() : playEndpoints.endPause()), (p) => (p.pause.active === on ? p.pause : null)),
    {
      optimistic: { apply: (on) => setFlipped(on), rollback: () => setFlipped(null) },
      success: ({ value }) => { setFlipped(null); onChanged(value); },
    },
  );
  const checked = flipped ?? pause.active;
  const left = Math.max(0, pause.weeks_per_year - pause.weeks_used_this_year);
  const off = pause.weeks_per_year === 0;
  const usedUp = left === 0 && !off;
  const unavailable = off || (usedUp && !pause.active);
  return (
    // R7 L7-5 — a rem query on the card's own box: where the text is large for it (320 / 200 %) the
    // switch drops under the words, which take the whole width (they were a ~70px column, broken
    // mid-word). With room, the switch stands beside them as before.
    <div data-pause={checked ? "on" : "off"} className="@container/pause flex flex-col gap-2 border-t border-border pt-4">
      <Field className={PAUSE_FIELD}>
        <div className="flex min-w-0 flex-col gap-0.5 break-words">
          <FieldLabel className="inline-flex items-center gap-1.5">
            {/* R7 L6-16 — 16px at 100 % text, growing with it. */}
            <PauseIcon size="1rem" aria-hidden="true" className="shrink-0" />
            {PAUSE_COPY.label}
          </FieldLabel>
          <FieldDescription className="break-words">{hint(pause, left, year)}</FieldDescription>
        </div>
        <div className={PAUSE_CONTROL}>
          {toggle.pending ? <Spinner className="text-text-secondary" label={PAUSE_COPY.label} /> : null}
          <Switch
            checked={checked}
            disabled={unavailable}
            aria-busy={toggle.pending || undefined}
            onCheckedChange={(next) => { if (!toggle.pending) void toggle.run(next); }}
          />
        </div>
      </Field>
      {toggle.error ? (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-danger-strong">
          <WarningCircle size="1rem" weight="bold" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{playRefusal(toggle.error, PAUSE_COPY.action, PLAY_SETTINGS_UNSURE.pause)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Written whole, so Tailwind's scanner sees every class. */
const PAUSE_FIELD = "grid-cols-1 items-start gap-x-4 @[20rem]/pause:grid-cols-[minmax(0,1fr)_auto]";
const PAUSE_CONTROL = "flex min-h-touch items-center gap-2 @[20rem]/pause:col-start-2 @[20rem]/pause:row-span-full";

function hint(pause: Pause, left: number, year: number): string {
  if (pause.weeks_per_year === 0) return PAUSE_COPY.off;
  if (left === 0) return PAUSE_COPY.usedUp(pause.weeks_per_year, year);
  return PAUSE_COPY.hint(left, pause.weeks_per_year, year);
}
