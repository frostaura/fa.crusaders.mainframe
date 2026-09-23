import { memo } from "react";
import type { AdminSettings } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { WarningCircle } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import {
  DAY_KEYS, DAY_NAMES, formatDayHours, operatingHoursComplaint, parseDayHours, settingAnchorId,
  type DayHours, type DayKey,
} from "@/lib/tenantSettings";
import { minuteLabel } from "@/lib/settingsSchema";
import { SETTINGS_COPY } from "@/lib/settingsCopy";
import { HIGHLIGHT_CLASS, clockStep } from "./draft";
import { useSettingsForm } from "./form";
import { ClockSelect } from "./SettingControl";

/**
 * The club's opening hours, per weekday.
 *
 * <p>
 * This is the map the booking rules enforce. The flat Day starts / Day ends pair above is only
 * the default for a weekday the map does not name — and while it was the only thing this screen
 * could edit, a club that changed it got "Settings saved." and a Saturday that still ran on the
 * map's hours (R2 G-F2). A day is either on the club default or has hours of its own; there is no
 * "closed all day", because the engine has no way to express one — a close at or before its open
 * is refused as the typo it almost always is, at the row, before anything is sent.
 * </p>
 */
export function OperatingHours() {
  const { settings, update, highlighted } = useSettingsForm();
  return (
    <WeekTable
      map={settings.operating_hours}
      dayStart={settings.day_start_minute}
      dayEnd={settings.day_end_minute}
      highlighted={highlighted}
      update={update}
    />
  );
}

/** Memoised on the four facts it draws from, so typing elsewhere on the page skips fourteen pickers. */
const WeekTable = memo(function WeekTable(props: {
  map: Record<string, string> | undefined; dayStart: number; dayEnd: number; highlighted: string | null;
  update: (patch: Partial<AdminSettings>) => void;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { dayStart, dayEnd, highlighted, update } = props;
  const map = props.map ?? {};
  const complaint = operatingHoursComplaint(map);
  const fallback = { open: minuteLabel(dayStart), close: minuteLabel(dayEnd) };
  const step = clockStep(Object.values(map).flatMap((range) => range.split("-")));

  const setDay = (day: DayKey, hours: DayHours | null) => {
    const next = { ...map };
    if (hours === null) delete next[day];
    else next[day] = formatDayHours(hours);
    update({ operating_hours: next });
  };

  return (
    <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {DAY_KEYS.map((day) => (
        <DayRow
          key={day}
          day={day}
          hours={parseDayHours(map[day])}
          fallback={fallback}
          step={step}
          error={complaint?.day === day ? complaint.message : null}
          highlighted={highlighted === settingAnchorId(`operating_hours_${day}`)}
          onChange={(next) => setDay(day, next)}
        />
      ))}
    </div>
  );
});

function DayRow(props: {
  day: DayKey; hours: DayHours | null; fallback: DayHours; step: number; error: string | null;
  highlighted: boolean; onChange: (next: DayHours | null) => void;
}) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { day, hours, fallback, step, error, onChange } = props;
  const name = DAY_NAMES[day];
  const custom = hours !== null;
  const shownHours = hours ?? fallback;
  // The row is a setting too, as far as the save bar's summary is concerned.
  const anchorId = settingAnchorId(`operating_hours_${day}`);
  return (
    <div
      id={anchorId}
      className={cn(
        "grid scroll-mt-28 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-3 py-3 sm:grid-cols-[8rem_auto_minmax(0,1fr)]",
        props.highlighted && HIGHLIGHT_CLASS,
      )}
    >
      <span className="text-sm font-semibold text-text-primary">{name}</span>
      <label className="flex min-h-touch items-center justify-end gap-2 text-sm text-text-secondary sm:justify-start">
        <Switch
          checked={custom}
          aria-label={SETTINGS_COPY.ownHoursLabel(name)}
          // Switching a day on starts it at the club default rather than at 00:00, so the first
          // thing an admin sees is the hours actually in force for it.
          onCheckedChange={(checked) => onChange(checked ? shownHours : null)}
        />
        <span aria-hidden="true">{SETTINGS_COPY.ownHours}</span>
      </label>
      <div className="col-span-2 flex flex-col gap-2 sm:col-span-1">
        {custom ? (
          <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:max-w-sm">
            <ClockSelect
              label={SETTINGS_COPY.opens(name)}
              start="00:00" end="23:59" step={step}
              value={shownHours.open}
              className={cn(error && "border-danger-strong")}
              onChange={(open) => onChange({ ...shownHours, open })}
            />
            <span className="text-sm text-text-muted">to</span>
            <ClockSelect
              label={SETTINGS_COPY.closes(name)}
              start="00:00" end="24:00" includeEnd step={step}
              value={shownHours.close}
              className={cn(error && "border-danger-strong")}
              onChange={(close) => onChange({ ...shownHours, close })}
            />
          </div>
        ) : (
          <span className="text-sm text-text-muted">{SETTINGS_COPY.dayDefault(fallback.open, fallback.close)}</span>
        )}
        {error ? (
          <p className="flex items-start gap-1.5 text-sm font-medium text-danger-strong">
            <WarningCircle aria-hidden="true" size={16} weight="bold" className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
