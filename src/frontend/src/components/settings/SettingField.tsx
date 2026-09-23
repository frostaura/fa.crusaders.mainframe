import { memo, useId, useState } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { InfoPopover } from "@/components/ui/info-popover";
import { cn } from "@/lib/utils";
import { settingAnchorId } from "@/lib/tenantSettings";
import { isServed, resolve, settingLabel, unitOf, type SettingDef } from "@/lib/settingsSchema";
import { HIGHLIGHT_CLASS, takesDescription } from "./draft";
import { useSettingsForm } from "./form";
import { Highlight } from "./Highlight";
import { SettingControl, type ControlProps } from "./SettingControl";

/**
 * One setting: caption, (i), control, error, one line of description (plan R13: "Field rows with
 * label, description, InfoPopover for deeper guidance, the right control").
 *
 * <p>
 * <b>Three layers of words, each where it earns its place.</b> The caption names the setting. The
 * description — one line, always visible — says what it IS, with the range it accepts. The full
 * guidance (what it reaches, what the bound is for, what changing it costs) sits behind the (i),
 * because a paragraph under every one of seventy fields is what made this page overwhelming; it is
 * ALSO on the control's `aria-describedby`, visually hidden, so a screen reader hears everything
 * without having to find a popover.
 * </p>
 *
 * <p>
 * <b>A refused value is said on the field, and said out loud when the person leaves it.</b> (C12)
 * `aria-describedby` is read when a screen reader ARRIVES at a field, never when the value in it
 * goes bad, so an admin typing 400 into a field bounded at 30 and tabbing on was told nothing
 * until Save. The polite region below speaks on blur — a finished answer, not a half-typed one —
 * and is derived, so a message cannot outlive the mistake it is about.
 * </p>
 *
 * <p>
 * An optional setting the API does not serve renders NOTHING: an input bound to `undefined` is an
 * uncontrolled field that reports a save of a value nobody typed.
 * </p>
 */
export function SettingField({ def }: { def: SettingDef }) {
  const form = useSettingsForm();
  if (!isServed(def, form.settings)) return null;
  const anchorId = settingAnchorId(def.key);
  return (
    <SettingRow
      def={def}
      value={(form.settings as unknown as Record<string, unknown>)[def.key]}
      update={form.update}
      error={form.errors[def.key]}
      highlighted={form.highlighted === anchorId}
      hidden={!form.visible(def.key)}
      query={form.query}
      currency={form.context.currency}
      help={resolve(def.help, form.context)}
      max={resolve(def.max, form.context)}
    />
  );
}

type RowProps = Omit<ControlProps, "describedBy" | "invalid"> & {
  error: string | undefined;
  highlighted: boolean;
  hidden: boolean;
  query: string;
  help: string | undefined;
};

/** The row itself, memoised on plain values — see `SettingControl` for why that matters. */
const SettingRow = memo(function SettingRow(props: RowProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { def, error, highlighted, hidden, query, currency, help } = props;
  const helpId = useId();
  const [left, setLeft] = useState(false);
  const label = settingLabel(def.key, currency);
  const wired = help !== undefined && takesDescription(def);

  return (
    <Field
      id={settingAnchorId(def.key)}
      data-setting={def.key}
      hidden={hidden}
      className={cn("scroll-mt-28 rounded-lg [&[hidden]]:hidden", highlighted && HIGHLIGHT_CLASS)}
      onFocus={() => setLeft(false)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setLeft(true); }}
    >
      <div className="-mb-1 flex min-h-8 items-center justify-between gap-2">
        <FieldLabel><Highlight text={label} query={query} /></FieldLabel>
        {help ? (
          <InfoPopover label={label} className="-my-2 -mr-2">{help}</InfoPopover>
        ) : null}
      </div>
      <SettingControl {...props} describedBy={wired ? helpId : undefined} invalid={error !== undefined} />
      <FieldError>{error}</FieldError>
      <FieldDescription className="text-text-muted">
        <Highlight text={describe(def, currency)} query={query} />
      </FieldDescription>
      {wired ? <p id={helpId} className="sr-only">{help}</p> : null}
      <p aria-live="polite" className="sr-only">{left && error ? `${label}: ${error}` : ""}</p>
    </Field>
  );
});

/** The visible line: what the setting is, then the range it accepts, in its own unit. */
function describe(def: SettingDef, currency: string): string {
  const line = def.description.replaceAll("{currency}", currency);
  if (def.kind !== "number" || def.min === undefined || typeof def.max !== "number") return line;
  const unit = unitOf(def, currency);
  const range = def.minExclusive ? `more than 0, up to ${def.max}` : `${def.min}–${def.max}`;
  const suffix = unit && !def.unitBefore ? ` ${unit}` : "";
  return `${line} Allowed: ${range}${suffix}.`;
}
