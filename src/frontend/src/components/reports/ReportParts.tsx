import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Minutes } from "@/components/Minutes";
import { typography } from "@/lib/typography";
import { Toggle } from "@/components/ui/toggle";
import { AutoGrid } from "@/components/ui/auto-grid";
import { Card } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { Carousel, type CarouselSlide } from "../Carousel";
import { RANGE_PRESETS, clubToday, matchingPreset, presetRange, type ReportRange } from "./range";

/**
 * The parts the member's Activity and the club's Reports are built from — one vocabulary for
 * both, so the two halves of the old `/reports` cannot drift into two looks.
 */

/**
 * The period, and the quick ways to set it.
 *
 * <p>
 * Two date pickers (club days, never instants — see `range.dayMarkers`) and the monthly presets
 * the client blueprint asks for (C.4). The presets are toggle buttons (`aria-pressed`): pressing
 * one sets both dates, and the one whose dates are showing reads as pressed, so a member can
 * tell "last month" from a custom range that happens to look like it. `children` is the page's
 * own action for the period — the member's CSV download — pushed to the right.
 * </p>
 */
export function RangeToolbar({ range, onChange, children }: {
  range: ReportRange; onChange: (next: ReportRange) => void; children?: ReactNode;
}) {
  const today = clubToday();
  const active = matchingPreset(range, today);
  return (
    <div className="flex flex-wrap items-end gap-x-4 gap-y-3 rounded-xl border border-border bg-bg-surface p-3 shadow-xs sm:p-4">
      <div className="flex flex-wrap items-end gap-3">
        <DayField label="From">
          <DatePicker label="From" value={range.from} max={range.to} onChange={(from) => onChange({ ...range, from })} />
        </DayField>
        <DayField label="To">
          <DatePicker label="To" value={range.to} min={range.from} max={today} onChange={(to) => onChange({ ...range, to })} />
        </DayField>
      </div>
      {/* Toggles (`aria-pressed`), not a radio group: a custom range presses none of them, and
          pressing the one already on simply sets it again. */}
      <div role="group" aria-label="Quick ranges" className="flex flex-wrap gap-2">
        {RANGE_PRESETS.map((preset) => (
          <Toggle
            key={preset.id}
            variant="outline"
            pressed={active === preset.id}
            onPressedChange={() => onChange(presetRange(preset.id, today))}
          >
            {preset.label}
          </Toggle>
        ))}
      </div>
      {children ? <div className="flex flex-wrap gap-2 sm:ml-auto">{children}</div> : null}
    </div>
  );
}

/** A visible caption above a date picker. The picker names itself ("From: Tue 1 Sep") for AT. */
function DayField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden="true" className="text-sm font-medium text-text-primary">{label}</span>
      {children}
    </div>
  );
}

export type TileTone = "accent" | "success" | "warning" | "neutral";

/** Tone → fill and ink. Existing soft/strong pairs, every one measured ≥4.5:1 in both themes. */
const TILE_TONES: Record<TileTone, string> = {
  accent: "bg-accent-soft text-accent-strong",
  success: "bg-success-soft text-success-strong",
  warning: "bg-warning-soft text-warning-strong",
  neutral: "bg-bg-muted text-text-primary",
};

/** `value` is a node so a minutes figure can carry its spoken form (`<Minutes>`). */
export type Tile = { label: string; value: ReactNode; tone: TileTone };

/**
 * The headline figures for a period: as many 9rem tiles across as the BOX holds, four at most
 * (R5 X5-4). A fixed `grid-cols-2` at 390 with 200 % text gave each tile 150px and `break-words`
 * cut the money mid-figure ("R2 / 50. / 50"); an AutoGrid falls to one column there instead, and
 * a figure only ever breaks between its parts ("1 d / 6 h"), never inside a number.
 */
export function StatTiles({ tiles, label }: { tiles: Tile[]; label: string }) {
  return (
    <AutoGrid as="dl" min="stat" max={4} gap="md" aria-label={label} data-stat-tiles="">
      {tiles.map((tile) => (
        <div key={tile.label} className={cn("flex min-w-0 flex-col gap-1 rounded-xl p-4", TILE_TONES[tile.tone])}>
          <dt className="break-words text-xs font-semibold uppercase tracking-overline">{tile.label}</dt>
          <dd className="text-2xl font-semibold tabular-nums tracking-tight">{tile.value}</dd>
        </div>
      ))}
    </AutoGrid>
  );
}

/** One labelled figure in a totals list. `dt` then `dd`, so the pair reads as one line. */
export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-bg-muted px-3 py-2.5">
      <dt className={typography({ variant: "overline" })}>{label}</dt>
      <dd className="break-words text-base font-semibold tabular-nums text-text-primary">{value}</dd>
    </div>
  );
}

/**
 * How many across at most — chosen by the caller so its count fills whole rows (VIS F3-15). An
 * AutoGrid of 9rem tiles (R4 form factor): two across on a phone as before, ONE at 200 % text,
 * where "MOVEMENTS" in a half column ran 10px off a 390 screen.
 */
type TotalColumns = 3 | 4 | 5;

/** A card of {@link Stat}s and the sentence that says how they add up. */
export function TotalsCard({ children, footnote, columns = 4 }: {
  children: ReactNode; footnote: ReactNode;
  /** Ten totals in four columns left two orphans on the admin page; five across fill two rows. */
  columns?: TotalColumns;
}) {
  return (
    <Card className="px-4 sm:px-6">
      <AutoGrid as="dl" min="stat" max={columns} gap="md">{children}</AutoGrid>
      <p className="text-sm text-text-secondary">{footnote}</p>
    </Card>
  );
}

/** The period's charts, one per slide. */
export function ChartsCard({ slides }: { slides: CarouselSlide[] }) {
  if (slides.length === 0) return null;
  return (
    <Card className="px-3 sm:px-4">
      <Carousel slides={slides} />
    </Card>
  );
}

/**
 * A net minutes figure, with a negative one marked.
 *
 * <p>
 * Settlement-model I11: a correction posts a new row of the same type with the opposite sign
 * rather than editing the row it corrects, so a period bucket goes negative whenever a reversal
 * lands in a different day's bucket from the sweep it reverses. A minus here is the netting
 * working, and the number is shown as it is rather than as its magnitude — printing |x| would
 * make the two days indistinguishable and hide the only trace on this screen that a reversal
 * happened at all. Marked in the warning ink: "look at this day", not "error".
 * </p>
 */
export function NetMinutes({ value }: { value: number }) {
  // Warning ink, not `<Minutes>`' own danger ink: a negative day is the netting working.
  return <Minutes value={value} className={cn("whitespace-nowrap", 0 > value && "font-medium text-warning-strong")} />;
}

/**
 * @deprecated P13 — the member's Activity page (F2) still imports the old name; it goes when
 * that page moves to {@link NetMinutes} (phase 2 deletes it either way).
 */
export const NetCredits = NetMinutes;

/**
 * A table cell's figure or date, kept on one line. A phone's table scrolls sideways inside its
 * own region; a "2 h 40 min" broken over two lines, or a date over three, is a column nobody can
 * scan down.
 */
export function Cell({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap tabular-nums">{children}</span>;
}

/** Says once, under the table, what the "(net)" in those column headers means. */
export function NetNote({ what }: { what: string }) {
  return (
    <p className="text-sm text-text-secondary">
      {what} are net. A reversal is posted as an opposite-sign row on the day it lands, so a day reads negative when
      more was reversed on it than posted — usually because the sweep and the reversal fell on different days.
    </p>
  );
}

/** A table's footnotes, in one stack under it. */
export function TableNotes({ children }: { children: ReactNode }) {
  return <div className="flex max-w-prose flex-col gap-2">{children}</div>;
}

/** The report's layout while its first read is in flight: tiles, a chart, a table. */
export function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      {/* The tiles' own grid, so the skeleton holds the shape the figures arrive in (R5 X5-4). */}
      <AutoGrid min="stat" max={4} gap="md">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </AutoGrid>
      <Skeleton className="h-40 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}
      </div>
    </div>
  );
}
