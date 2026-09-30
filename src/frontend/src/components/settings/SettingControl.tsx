import { useCallback, useId, useMemo, useState } from "react";
import type { AdminSettings } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { timeOptions } from "@/components/ui/time-select";
import { cn } from "@/lib/utils";
import { timezoneOptions } from "@/lib/tenantSettings";
import { minuteLabel, minuteOfLabel, parsePeakHours, unitOf, type SettingDef } from "@/lib/settingsSchema";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { clockStep, shown, toNumber } from "./draft";

/**
 * The right control for each kind of setting (plan R13: "Switch / Select / TimeSelect / number
 * Field with unit suffix / TextArea").
 *
 * <p>
 * Every control takes its id, its label and its error wiring from the enclosing `Field`
 * (`ui/field.tsx`); `describedBy` is the setting's full guidance, joined to the field's own
 * description and error so a screen reader hears all three. Nothing here is a raw `<input>` or
 * `<select>` — each is a design-system primitive.
 * </p>
 *
 * <p>
 * <b>Props, not context.</b> Each control is handed its own value and nothing else, so the row
 * around it can be memoised: typing in one of seventy fields re-renders that one row, not the page
 * — which on a phone is the difference between a field that keeps up with a thumb and one that
 * does not.
 * </p>
 */
export type ControlProps = {
  def: SettingDef;
  value: unknown;
  update: (patch: Partial<AdminSettings>) => void;
  describedBy?: string;
  invalid?: boolean;
  currency: string;
  max?: number;
};

const patch = (key: string, value: unknown) => ({ [key]: value }) as Partial<AdminSettings>;

function NumberControl(props: ControlProps) {
  const { def, value, update, describedBy, invalid, currency, max } = props;
  const unit = unitOf(def, currency);
  const before = unit !== undefined && def.unitBefore === true;
  return (
    <div className="relative">
      {before ? <Unit side="left">{unit}</Unit> : null}
      <Input
        type="number"
        inputMode={def.integer ? "numeric" : "decimal"}
        min={def.min}
        max={max}
        step={def.step}
        value={shown(value as number | undefined)}
        aria-describedby={describedBy}
        className={cn("tabular-nums", NO_SPINNER, before ? "pl-10" : unit && "pr-16", invalid && "ring-1 ring-danger-strong")}
        onChange={(event) => update(patch(def.key, toNumber(event.target.value)))}
      />
      {unit !== undefined && !before ? <Unit side="right">{unit}</Unit> : null}
    </div>
  );
}

/**
 * No native stepper (VIS F3-15): Chrome draws it at the end of the content box, which is where the
 * unit sits, and the two overlapped ("10 ▴▾s"). A 15px double arrow is no touch target anyway; the
 * keyboard's arrows still step the value.
 */
const NO_SPINNER = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

/** The unit inside the control's edge. Hidden from assistive tech: the caption already says it. */
function Unit({ side, children }: { side: "left" | "right"; children: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 flex items-center text-sm text-text-muted",
        side === "left" ? "left-3" : "right-3",
      )}
    >
      {children}
    </span>
  );
}

function TextControl({ def, value, update, describedBy, invalid }: ControlProps) {
  return (
    <Input
      type={def.kind === "email" ? "email" : def.kind === "tel" ? "tel" : "text"}
      inputMode={def.kind === "tel" ? "tel" : def.kind === "email" ? "email" : "text"}
      value={typeof value === "string" ? value : ""}
      maxLength={def.maxLength}
      placeholder={def.placeholder}
      aria-describedby={describedBy}
      className={cn(invalid && "ring-1 ring-danger-strong")}
      onChange={(event) => update(patch(def.key, event.target.value))}
    />
  );
}

type Option = { value: string; label: string };

/** Past this many options a Select renders its list only while open. */
const LAZY_AFTER = 24;

/**
 * A long list rendered only while it is open.
 *
 * <p>
 * Radix renders a CLOSED Select's items off-screen, so it can show the chosen item's text. This
 * page has up to twenty time pickers of ~96 slots and a ~400-zone timezone list — some two
 * thousand hidden items mounted and reconciled for nothing. A long list instead names its value
 * itself (`SelectValue`'s children) and mounts its items on open.
 * </p>
 */
function useLazyItems(count: number) {
  const [open, setOpen] = useState(false);
  const enabled = count > LAZY_AFTER;
  return {
    enabled,
    show: !enabled || open,
    select: enabled ? { open, onOpenChange: setOpen } : {},
  };
}

function ChoiceControl({ def, value: raw, update, describedBy, options }: ControlProps & { options: readonly Option[] }) {
  // A value this build cannot render shows the placeholder — never a blank that saves as itself.
  const value = typeof raw === "string" && options.some((option) => option.value === raw) ? raw : "";
  // The same element objects every render, so React skips the list: Radix renders a closed
  // Select's items off-screen, and a timezone list is ~400 of them.
  const items = useMemo(() => options.map((option) => (
    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
  )), [options]);
  const lazy = useLazyItems(options.length);
  const label = options.find((option) => option.value === value)?.label;
  return (
    <Select value={value} onValueChange={(next) => update(patch(def.key, next))} {...lazy.select}>
      <SelectTrigger aria-describedby={describedBy}>
        <SelectValue placeholder="Choose one">{lazy.enabled ? label : undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent>{lazy.show ? items : null}</SelectContent>
    </Select>
  );
}

function TimezoneControl(props: ControlProps) {
  const zone = typeof props.value === "string" ? props.value : "";
  // A zone the runtime does not list is still offered, or the picker would show the club a zone
  // it is not on and then save that.
  const options = useMemo(() => timezoneOptions(zone).map((value) => ({ value, label: value })), [zone]);
  return <ChoiceControl {...props} options={options} />;
}

function SwitchControl({ def, value, update, describedBy }: ControlProps) {
  const on = value === true;
  return (
    <div className="flex min-h-touch items-center gap-3">
      <Switch
        checked={on}
        aria-describedby={describedBy}
        onCheckedChange={(checked) => update(patch(def.key, checked))}
      />
      <span aria-hidden="true" className="text-sm text-text-secondary">
        {on ? SETTINGS_COPY.switchOn : SETTINGS_COPY.switchOff}
      </span>
    </div>
  );
}

/**
 * A club time, chosen from aligned options — `ui/time-select`'s rule (never free-typed), drawn
 * without its leading clock: at the time of writing `SelectTrigger`'s `[&>span]:line-clamp-1` turns
 * TimeSelect's icon-plus-value row into a `-webkit-box`, stacking the clock ABOVE the time. Fixing
 * that is the primitive owner's; a settings row does not need the icon.
 */
export function ClockSelect(props: {
  label?: string; id?: string; start: string; end: string; step: number; includeEnd?: boolean;
  value: string | undefined; onChange: (time: string) => void; className?: string;
}) {
  const { label, id, start, end, step, includeEnd = false, value, onChange, className } = props;
  const options = useMemo(() => timeOptions(start, end, step, includeEnd), [start, end, step, includeEnd]);
  const current = value && options.includes(value) ? value : "";
  const items = useMemo(() => options.map((option) => (
    <SelectItem key={option} value={option} className="tabular-nums">{option}</SelectItem>
  )), [options]);
  const lazy = useLazyItems(options.length);
  return (
    <Select value={current} onValueChange={onChange} {...lazy.select}>
      <SelectTrigger id={id} aria-label={label} className={cn("tabular-nums", className)}>
        <SelectValue placeholder="Choose a time">{current || undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent>{lazy.show ? items : null}</SelectContent>
    </Select>
  );
}

function MinuteControl({ def, value: minutes, update }: ControlProps) {
  const value = minuteLabel(minutes as number);
  const isEnd = def.key === "day_end_minute";
  const onChange = useCallback((next: string) => update(patch(def.key, minuteOfLabel(next))), [def.key, update]);
  return (
    <ClockSelect
      start="00:00"
      end={isEnd ? "24:00" : "23:59"}
      includeEnd={isEnd}
      step={clockStep([value])}
      value={value}
      onChange={onChange}
    />
  );
}

function halves(value: string): { start?: string; end?: string } {
  const [start, end] = value.split("-").map((part) => part.trim());
  return { start: start || undefined, end: end || undefined };
}

function PeakHoursControl({ value, update }: ControlProps) {
  const endId = useId();
  const text = typeof value === "string" ? value : "";
  // Each half read on its own, so choosing the start of a range the API sent broken does not
  // throw away an end that was fine — the half that is not a time shows the placeholder.
  const parsed = parsePeakHours(text) ?? halves(text);
  const step = clockStep([parsed.start, parsed.end]);
  const set = (start: string | undefined, end: string | undefined) =>
    update({ peak_hours: `${start ?? ""}-${end ?? ""}` });
  return (
    <div role="group" className="grid grid-cols-2 gap-3">
      <ClockSelect
        label={SETTINGS_COPY.peakStarts}
        start="00:00" end="23:59" step={step}
        value={parsed.start}
        onChange={(next) => set(next, parsed.end)}
      />
      <ClockSelect
        id={endId}
        label={SETTINGS_COPY.peakEnds}
        start="00:00" end="24:00" includeEnd step={step}
        value={parsed.end}
        onChange={(next) => set(parsed.start, next)}
      />
    </div>
  );
}

export function SettingControl(props: ControlProps) {
  switch (props.def.kind) {
    case "number": return <NumberControl {...props} />;
    case "select": return <ChoiceControl {...props} options={props.def.options ?? []} />;
    case "timezone": return <TimezoneControl {...props} />;
    case "switch": return <SwitchControl {...props} />;
    case "minuteOfDay": return <MinuteControl {...props} />;
    case "peakHours": return <PeakHoursControl {...props} />;
    default: return <TextControl {...props} />;
  }
}
