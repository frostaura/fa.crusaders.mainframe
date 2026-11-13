import { useState } from "react";
import type { AdminDevice, AdminSettings } from "../../lib/api";
import {
  COMMISSIONING_STEPS, HW_DESCRIPTIONS, HW_KEYS, HW_LABELS, HW_NUMERIC, RELAY_LEVEL_CONFIRM, hwChoices, hwClubValue,
  hwEffective, hwRange, hwReported, hwValueWords, noLcdAnswered, servesHardware, type HwKey,
} from "../../lib/deviceHardware";
import {
  diagLines, driftLine, healthNeedsAttention, megaLines, servesHealth, type HealthLine, type MegaDiagName,
} from "../../lib/deviceHealth";
import { ConfirmDialog } from "../admin/ConfirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

/**
 * One court box's hardware facts and health (device-api §10, §12, §13; HW-1…HW-6, HW-11, ESPR-2).
 *
 * <p>
 * <b>Set beside reported.</b> Every hardware row shows what the board is told and what the Mega
 * says it is actually running with, because after the last cable flash that is the only proof a
 * remote fix landed. <i>No screen answered</i> (`mega.lcd` = `00`) is an attention state, not a
 * value.
 * </p>
 */

/** A hardware save: per key, absent = unchanged, null = the club's, a value = this board's own. */
export type HwPatch = {
  hw_relay_active_level?: string | null; hw_lcd_i2c_address?: number | null; hw_scanner_baud?: number | null;
  hw_scanner_line_end?: string | null; hw_scanner_gap_ms?: number | null;
};

/** What the board says it runs with, per key, beside what it is set to. */
export function BoardHardwareSummary({ device, settings }: { device: AdminDevice; settings: AdminSettings | null }) {
  if (!servesHardware(device)) return null;
  return (
    <div className="flex flex-col gap-1" data-board-hardware="">
      {noLcdAnswered(device) && (
        <p role="status" className="text-sm font-medium text-danger-strong" data-no-lcd="">
          No screen answered this box. Check the screen's four wires and its contrast screw before anything else.
        </p>
      )}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-text-secondary sm:grid-cols-[auto_1fr]">
        {HW_KEYS.map((key) => {
          const set = hwValueWords(key, hwEffective(device, settings, key));
          const own = device[key] !== null && device[key] !== undefined;
          const reported = hwReported(device, key);
          return (
            <div key={key} className="contents">
              <dt className="font-medium text-text-primary">{HW_LABELS[key]}</dt>
              <dd>
                {`set to ${set}${own ? " (this board's own)" : " (the club's)"}`}
                {reported ? ` · the box says ${reported}` : ""}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

type Choice = string;
const CLUB = "__club__";

function initialChoice(device: AdminDevice, key: HwKey): Choice {
  const v = device[key];
  return v === null || v === undefined ? CLUB : String(v);
}

/** The five overrides, three-valued; the relay level behind a confirm that says what a lit court does. */
export function BoardHardwareEditor({ device, settings, onSave, onClose }: {
  device: AdminDevice;
  settings: AdminSettings | null;
  onSave: (patch: HwPatch) => Promise<boolean>;
  onClose: () => void;
}) {
  const [choices, setChoices] = useState<Record<HwKey, Choice>>(
    () => Object.fromEntries(HW_KEYS.map((key) => [key, initialChoice(device, key)])) as Record<HwKey, Choice>);
  const [saving, setSaving] = useState(false);

  const built: Record<string, string | number | null> = {};
  for (const key of HW_KEYS) {
    if (choices[key] === initialChoice(device, key)) continue;
    built[key] = choices[key] === CLUB ? null : HW_NUMERIC.has(key) ? Number(choices[key]) : choices[key];
  }
  const patch = built as HwPatch;
  const relayChanges = "hw_relay_active_level" in patch
    && hwEffectiveAfter(settings, patch.hw_relay_active_level) !== hwEffective(device, settings, "hw_relay_active_level");

  async function save() {
    setSaving(true);
    try {
      if (await onSave(patch)) onClose();
    } finally {
      setSaving(false);
    }
  }

  const nothing = Object.keys(patch).length === 0;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-bg-muted p-2 @[16rem]/boardslot:p-4" data-hardware-editor="">
      {HW_KEYS.map((key) => (
        <HwField key={key} hwKey={key} device={device} settings={settings} value={choices[key]}
          onChange={(v) => setChoices((c) => ({ ...c, [key]: v }))} />
      ))}
      <div className="flex flex-wrap gap-2">
        {relayChanges ? (
          <ConfirmDialog
            trigger={<Button pending={saving}>Save hardware</Button>}
            title={`Change ${device.name}'s relay drive level?`}
            description={RELAY_LEVEL_CONFIRM}
            confirmLabel="Change the drive level"
            cancelLabel="Keep it as it is"
            onConfirm={async () => { if (!(await onSave(patch))) throw new Error("not saved"); onClose(); }}
            action="change the relay drive level"
          />
        ) : (
          <Button pending={saving} disabled={nothing} onClick={() => void save()}>Save hardware</Button>
        )}
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
      </div>
      <p className="text-xs text-text-muted">The box takes a change the next time it calls in, and reports what it is running with.</p>
    </div>
  );
}

function hwEffectiveAfter(settings: AdminSettings | null, next: string | number | null | undefined) {
  return next === null || next === undefined ? hwClubValue(settings, "hw_relay_active_level") : next;
}

function HwField({ hwKey, device, settings, value, onChange }: {
  hwKey: HwKey; device: AdminDevice; settings: AdminSettings | null; value: Choice; onChange: (v: Choice) => void;
}) {
  const club = `The club's (${hwValueWords(hwKey, hwClubValue(settings, hwKey))})`;
  const reported = hwReported(device, hwKey);
  const description = `${HW_DESCRIPTIONS[hwKey]}${reported ? ` The box says: ${reported}.` : ""}`;
  if (hwKey === "hw_scanner_gap_ms") {
    const range = hwRange(settings, hwKey);
    const own = value !== CLUB;
    return (
      <Field>
        <FieldLabel>{HW_LABELS[hwKey]}</FieldLabel>
        <label className="flex min-h-touch items-center gap-2 text-sm text-text-secondary">
          <Checkbox checked={!own} onCheckedChange={(c) => onChange(c === true ? CLUB : String(hwClubValue(settings, hwKey) ?? ""))} />
          {club}
        </label>
        {own && (
          <Input type="number" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)}
            min={range?.min} max={range?.max} />
        )}
        <FieldDescription>{description}</FieldDescription>
      </Field>
    );
  }
  const choices = hwChoices(settings, hwKey) ?? (value !== CLUB ? [value] : []);
  return (
    <Field>
      <FieldLabel>{HW_LABELS[hwKey]}</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={CLUB}>{club}</SelectItem>
          {choices.map((c) => <SelectItem key={c} value={c}>{hwValueWords(hwKey, HW_NUMERIC.has(hwKey) ? Number(c) : c)}</SelectItem>)}
        </SelectContent>
      </Select>
      <FieldDescription>{description}</FieldDescription>
    </Field>
  );
}

/** The commissioning procedure as a checklist (ticks are this admin's own, for the walk at the box). */
export function CommissioningChecklist({ device }: { device: AdminDevice }) {
  const [done, setDone] = useState<boolean[]>(() => COMMISSIONING_STEPS.map(() => false));
  return (
    <details className="rounded-lg border border-border p-2 text-sm" data-commissioning="">
      <summary className="min-h-touch cursor-pointer content-center font-medium text-text-primary">
        Commissioning {device.name}: {done.filter(Boolean).length} of {COMMISSIONING_STEPS.length} done
      </summary>
      <ol className="mt-2 flex flex-col gap-2">
        {COMMISSIONING_STEPS.map((step, i) => (
          <li key={step.title}>
            <label className="flex items-start gap-2">
              <Checkbox className="mt-0.5" checked={done[i]} onCheckedChange={(c) => setDone((d) => d.map((v, j) => (j === i ? c === true : v)))} />
              <span>
                <span className="font-medium text-text-primary">{`${i + 1}. ${step.title}. `}</span>
                <span className="text-text-secondary">{step.detail}</span>
              </span>
            </label>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** The board's own health (§13): three states — not yet reported, nothing reported, the report. */
export function BoardHealth({ device, rises }: { device: AdminDevice; rises: Partial<Record<MegaDiagName, number>> }) {
  if (!servesHealth(device)) return null;
  const drift = driftLine(device.drift);
  const lines: HealthLine[] = [...diagLines(device.diag), ...megaLines(device.mega, rises)];
  const attention = healthNeedsAttention(device) || lines.some((l) => l.attention);
  return (
    <div className="flex flex-col gap-1 text-xs" data-board-health={attention ? "attention" : "ok"}>
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary">Health</span>
        {attention && <Badge tone="warning">Needs a look</Badge>}
      </div>
      {drift && <p role="status" className="text-sm text-danger-strong" data-drift="">{drift}</p>}
      {lines.length === 0 && !drift && <p className="text-text-muted">It has not reported its health since it last started.</p>}
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-text-secondary">
          {lines.map((line) => (
            <li key={line.text} className={line.attention ? "font-medium text-warning" : undefined}>{line.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
