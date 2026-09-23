import { useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import { DatePicker } from "@/components/ui/date-picker";
import { TimeSelect } from "@/components/ui/time-select";
import { WeekStrip } from "@/components/ui/week-strip";
import { addDays, clubToday, Demo, ThemePair } from "./parts";

/**
 * Calendar, date picker, time select and the week strip, bounded to a two-week booking window
 * starting at the club's today. The picker's value is a club day string, never an instant.
 */
const WINDOW_DAYS = 13;

function CalendarDemo() {
  const [selected, setSelected] = useState<Date | undefined>(undefined);
  const today = clubToday();
  const [y, m, d] = today.split("-").map(Number);
  const first = new Date(y, m - 1, d);
  const last = new Date(y, m - 1, d + WINDOW_DAYS);
  return (
    <Calendar
      mode="single"
      selected={selected}
      onSelect={setSelected}
      disabled={[{ before: first }, { after: last }]}
    />
  );
}

function PickerDemo() {
  const today = clubToday();
  const [day, setDay] = useState(addDays(today, 2));
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text-primary">Date</span>
        <DatePicker label="Jump to a date" value={day} onChange={setDay} min={today} max={addDays(today, WINDOW_DAYS)} />
      </div>
      <TimeSelect label="Start time" start="06:00" end="22:00" stepMinutes={30} value={start} onChange={setStart} />
      <TimeSelect label="End time" start="06:30" end="22:00" stepMinutes={30} includeEnd value={end} onChange={setEnd} placeholder="Choose an end time" />
    </div>
  );
}

function WeekStripDemo() {
  const today = clubToday();
  const [day, setDay] = useState(today);
  const marked = new Set([addDays(today, 1), addDays(today, 4)]);
  return (
    <WeekStrip
      value={day}
      onChange={setDay}
      min={addDays(today, -7)}
      max={addDays(today, WINDOW_DAYS)}
      today={today}
      markedDays={marked}
      disablePast
    />
  );
}

export function DateTimeSection() {
  return (
    <div className="flex flex-col gap-10">
      <Demo title="Calendar" note="Monday first, the club time zone, a two-week window. Today has an edge and is bold.">
        <ThemePair>{() => <CalendarDemo />}</ThemePair>
      </Demo>
      <Demo title="Date picker and time select" note="A popover from 640px up, a bottom sheet below it. Times are slice-aligned, never typed.">
        <ThemePair>{() => <PickerDemo />}</ThemePair>
      </Demo>
      <Demo title="Week strip" note="Past days muted for members, today ringed, dots on days with a booking.">
        <ThemePair>{() => <WeekStripDemo />}</ThemePair>
      </Demo>
    </div>
  );
}
