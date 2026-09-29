/** `YYYY-MM-DD`, the only shape a club day travels in. */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → [year, monthIndex, day], or null for anything else. */
export function partsOf(day: string | null | undefined): [number, number, number] | null {
  const match = day ? DAY_PATTERN.exec(day) : null;
  if (!match) return null;
  return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Tue 23 Sep". Pure calendar arithmetic on the day itself — no zone can move it, and no date
 * library is needed to say it (the calendar's own module carries date-fns, lazily).
 */
export function formatClubDayLabel(day: string | null | undefined): string | null {
  const parts = partsOf(day);
  if (!parts) return null;
  const date = new Date(Date.UTC(parts[0], parts[1], parts[2]));
  return `${WEEKDAYS[date.getUTCDay()]} ${parts[2]} ${MONTHS[parts[1]]}`;
}
