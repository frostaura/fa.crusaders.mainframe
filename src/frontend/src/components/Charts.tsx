/* eslint-disable react-refresh/only-export-components -- the drawings (and the axis arithmetic) are exported for the tests that read their element trees; the components below wrap them. */
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ReferenceLine, Tooltip, XAxis, YAxis, Line, LineChart,
} from "recharts";
import { createElement } from "react";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { minutesCompact } from "../lib/minutes";
import { clubCalendarDate } from "@/lib/clubClock";
import { ChartFrame, type ChartPalette } from "./ChartFrame";

/**
 * The report charts.
 *
 * <p>
 * <b>Every colour comes from the palette the frame hands in</b>, read from the live theme on
 * each render (see `ChartFrame.useChartColors`). These used to be eight module constants
 * resolved once at load — first as hex literals that had drifted (a retired sky-blue accent, a
 * fourth grey nobody chose), then as token reads frozen at whichever theme the tab opened in.
 * Neither survives a product with a dark theme. Each chart is now a pure function of its data
 * and a {@link ChartPalette}; the exported component wraps it in the frame.
 * </p>
 */

/**
 * The axis type size: the product's 12px floor (design-system.md, Type — nothing smaller than
 * `xs` exists). It was 11, the one place on the report pages still under the floor.
 */
const AXIS_FONT_PX = 12;

/**
 * The height reserved above the plot for the topmost y-axis tick. A tick is centred on its
 * gridline, so the margin has to clear half a line of text; at 8px the top label was sliced in
 * half by the SVG's own edge.
 */
const TOP_MARGIN = 16;

/**
 * The narrowest y-axis gutter a minutes axis is given — a FLOOR, not the answer. The width each
 * chart uses comes from {@link minuteAxis}, computed from the labels it will actually draw.
 */
const MINUTE_AXIS_MIN_WIDTH = 40;

/**
 * The advance width of each glyph a minutes tick can contain, in pixels at the
 * {@link AXIS_FONT_PX} the axis is set in — measured in Chromium with `getComputedTextLength`
 * on Figtree 400 at 12px (P13, 2026-10-01: "1 h 30 min" 54.45, "−45 min" 44.48, "10 d" 22.64;
 * the per-glyph sums below reproduce each to within 0.1px). Figtree's figures are proportional,
 * so every digit is costed as the widest one ("0", 7.70): {@link labelWidth} is an upper bound,
 * which is the right side to be wrong on.
 */
const GLYPH_PX: Readonly<Record<string, number>> = {
  digit: 7.71, "\u00a0": 2.97, h: 6.71, d: 7.04, m: 10.22, i: 2.79, n: 6.71, "\u2212": 7.49, "+": 7.49,
};

/**
 * What recharts keeps between the plot and the tick text: `tickSize` 6 plus `tickMargin` 2. A
 * left axis anchors its tick text at `x + width - 8` with `text-anchor: end`, so a label wider
 * than `width - 8` starts left of the chart's own box — under the carousel's Previous arrow.
 */
const AXIS_TICK_GAP_PX = 8;

/** The gutter for an axis of plain integers — "12" needs nothing like the room "1 h 30 min" does. */
const COUNT_AXIS_WIDTH = 36;

/**
 * The left margin. Zero, not negative: `left: -12` pulled the axis labels outside the chart's
 * box, straight under the carousel's Previous arrow.
 */
const LEFT_MARGIN = 0;

const MARGIN = { top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN } as const;

/**
 * The tooltip, on the raised surface like every other floating thing (design-system.md,
 * Charts). recharts' default is a white box with `#ccc` edges and each row in its series'
 * colour — which on the dark theme is a white slab, and for a SOFT series (`success.soft`,
 * `accent.soft`) is a pale ghost of a row. Rows are body text here, and the swatch beside the
 * name is what identifies the series.
 */
function tooltipProps(c: ChartPalette) {
  return {
    // Radius xl and elevation 3 — the popover recipe (design-system.md, Elevation) — read from
    // the live theme's own shadow variable, so the dark theme's hairline highlight comes with it.
    contentStyle: {
      borderRadius: 14, border: `1px solid ${c.grid}`, background: c.tooltip,
      color: c.legend, fontSize: AXIS_FONT_PX, padding: "8px 12px", boxShadow: "var(--shadow-md)",
      fontVariantNumeric: "tabular-nums",
    },
    labelStyle: { color: c.muted, fontWeight: 600, marginBottom: 4 },
    itemStyle: { color: c.legend, padding: "1px 0" },
    // A bar chart's hover band and a line chart's hover rule: the hairline role, not recharts'
    // #ccc — which is a bright slab behind the bars on the dark theme.
    cursor: { fill: c.grid, fillOpacity: 0.5, stroke: c.grid },
  } as const;
}

/**
 * A legend whose labels can be read. recharts paints each label in its series' colour, and the
 * two series drawn with a SOFT fill measured 1.10:1 and 1.15:1 on white. The swatch keeps the
 * series colour and carries the identification; the text is set in `text.primary` like every
 * other label. `createElement`, not JSX: lizard reads a bare `<` in a .tsx file as a JSX open
 * tag and swallows the rest of the file into whichever function it was last inside.
 */
function legendProps(c: ChartPalette) {
  return {
    wrapperStyle: { fontSize: AXIS_FONT_PX, paddingTop: 8 },
    iconType: "circle" as const,
    iconSize: 8,
    formatter: (value: string) => createElement("span", { style: { color: c.legend } }, value),
  } as const;
}

/** Axis ticks and the axis line, in the muted token. */
function axisProps(c: ChartPalette) {
  return { fontSize: AXIS_FONT_PX, stroke: c.muted, tick: { fill: c.muted } } as const;
}

// Minutes, not rand. These charts plot ledger movements and court time, all of them in the
// club's unit of account — a rand sign here would claim a price nobody paid.
const fmtMinutes = (v: number | string) => minutesCompact(Number(v));

/**
 * U+00A0, written as an escape on purpose: a literal non-breaking space in source is invisible,
 * and an editor that normalises whitespace would silently put every tick back onto two lines.
 */
const NON_BREAKING_SPACE = "\u00a0";

/**
 * The same figure for an axis tick, with every space made non-breaking.
 *
 * <p>
 * recharts decides whether a tick fits by measuring its words in a hidden span that inherits
 * the BODY's font size, not the axis's, and breaks the label accordingly — "1 h" above "30 min".
 * A label with no breaking space in it is one word, and recharts never breaks a word. Not
 * applied to {@link fmtMinutes}: a tooltip is laid out in HTML and its text is copied by people.
 * </p>
 */
const fmtAxisMinutes = (v: number | string) => fmtMinutes(v).replaceAll(" ", NON_BREAKING_SPACE);

/** The width of one tick label as drawn, in pixels. An upper bound (see {@link GLYPH_PX}). */
function labelWidth(label: string): number {
  let width = 0;
  for (const ch of label) width += GLYPH_PX[/\d/.test(ch) ? "digit" : ch] ?? GLYPH_PX.digit;
  return width;
}

/**
 * The step between ticks on a minutes axis, smallest first: whole minutes, then quarter and
 * half hours, then whole hours, then whole days. Every tick is a figure a member reads at a
 * glance — "1 h", "2 h", "1 d" — where recharts' own decimal steps drew "1 h 40 min" and
 * "3 h 20 min" (a step of 100 minutes is round only to a computer).
 */
const MINUTE_STEPS = [
  1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720,
  1440, 2 * 1440, 5 * 1440, 10 * 1440, 20 * 1440, 50 * 1440, 100 * 1440, 200 * 1440, 500 * 1440,
] as const;

/** At most this many gaps between ticks before the outward rounding below. */
const TARGET_GAPS = 4;

/** The step for a span: the smallest in {@link MINUTE_STEPS} that keeps to {@link TARGET_GAPS}. */
function minuteStep(span: number): number {
  const fits = MINUTE_STEPS.find((step) => span / step <= TARGET_GAPS);
  if (fits !== undefined) return fits;
  const last = MINUTE_STEPS[MINUTE_STEPS.length - 1];
  return Math.ceil(span / TARGET_GAPS / last) * last;
}

/** What a minutes y-axis is told: where its ticks go, the domain they span, and its gutter. */
export type MinuteAxis = { ticks: number[]; domain: [number, number]; width: number };

/**
 * The y-axis for a chart of minutes, derived from the values its series reach.
 *
 * <ul>
 *   <li><b>Ticks on human steps</b> ({@link MINUTE_STEPS}), always including zero, because every
 *   one of these axes draws a zero line.</li>
 *   <li><b>A signed floor.</b> These series are <b>net</b> (settlement-model I11 posts every
 *   correction as a new opposite-sign row), so a day can be negative: the domain goes below zero
 *   exactly one step past the data, and never below zero when nothing is negative — floating the
 *   floor up to the data minimum would make every bar's length a lie.</li>
 *   <li><b>A gutter as wide as the widest label drawn</b>, so "−1 d 12 h" never overhangs the
 *   chart's own left edge, which is where the carousel's Previous arrow sits.</li>
 * </ul>
 *
 * Exported so the geometry tests can rebuild the expectation from the series each chart
 * declares.
 */
export function minuteAxis(values: readonly number[]): MinuteAxis {
  const finite = values.filter(Number.isFinite);
  const lo = Math.min(0, ...finite);
  const hi = Math.max(0, ...finite);
  // An empty or all-zero window still draws an hour, rather than a single tick at "0 min".
  const step = minuteStep(Math.max(hi - lo, 60));
  const first = Math.floor(lo / step) * step;
  const last = hi === lo ? first + 60 : Math.max(Math.ceil(hi / step) * step, first + step);
  const ticks: number[] = [];
  for (let tick = first; tick <= last; tick += step) ticks.push(tick === 0 ? 0 : tick);
  const widest = Math.max(...ticks.map((tick) => labelWidth(fmtAxisMinutes(tick))));
  return { ticks, domain: [first, last], width: Math.max(MINUTE_AXIS_MIN_WIDTH, Math.ceil(widest) + AXIS_TICK_GAP_PX) };
}

/** The YAxis props for a minutes axis — one spread, so no chart can take the ticks and not the width. */
function minuteYAxis(values: readonly number[], c: ChartPalette) {
  const axis = minuteAxis(values);
  return { ...axisProps(c), tickFormatter: fmtAxisMinutes, ticks: axis.ticks, domain: axis.domain, width: axis.width, interval: 0 } as const;
}

/**
 * The values a stacked signed chart's y-axis has to reach: `stackOffset="sign"` accumulates a
 * stack's positives upward and its negatives downward, so a day's reach is the sum of each sign
 * within each stack. `0 > v` rather than `v < 0` for the lizard reason above.
 */
function stackedExtremes(rows: readonly Record<string, unknown>[], stacks: readonly (readonly string[])[]): number[] {
  const out: number[] = [];
  for (const row of rows) {
    for (const keys of stacks) {
      const values = keys.map((k) => Number(row[k])).filter(Number.isFinite);
      out.push(values.filter((v) => v > 0).reduce((a, b) => a + b, 0));
      out.push(values.filter((v) => 0 > v).reduce((a, b) => a + b, 0));
    }
  }
  return out;
}

/** Which series share a stack, per chart — mirroring the `stackId`s on the bars below. */
const CLUB_FLOW_STACKS = [["top_ups_minutes"], ["booking_charges_minutes", "penalties_minutes"]];
const MEMBER_FLOW_STACKS = [["top_ups_minutes", "refunds_minutes"], ["spent_minutes"]];
/** F4-15 — the axis in the club's format ("1 Sep"), not the reader's locale ("Sep 01"). */
const fmtDate = (d: string) => clubCalendarDate(d, { weekday: false });

const minutesTooltip = { formatter: ((v: number) => fmtMinutes(v)) as never, labelFormatter: ((l: string) => fmtDate(l)) as never };
const dateTooltip = { labelFormatter: ((l: string) => fmtDate(l)) as never };

/** A soft vertical wash under an area series, in the series' own colour. */
function fillGradient(id: string, color: string, top: number) {
  return createElement(
    "defs", null,
    createElement(
      "linearGradient", { id, x1: "0", y1: "0", x2: "0", y2: "1" },
      createElement("stop", { offset: "0%", stopColor: color, stopOpacity: top }),
      createElement("stop", { offset: "100%", stopColor: color, stopOpacity: 0 }),
    ),
  );
}

export function drawRevenueArea(data: DailyAdminPoint[], c: ChartPalette) {
  return (
    <AreaChart data={data} margin={MARGIN}>
      {fillGradient("revFill", c.accent, 0.35)}
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis {...minuteYAxis(stackedExtremes(data, [["top_ups_minutes"]]), c)} />
      <Tooltip {...tooltipProps(c)} {...minutesTooltip} />
      <Area type="monotone" dataKey="top_ups_minutes" name="Minutes sold" stroke={c.accent} fill="url(#revFill)" strokeWidth={2} />
    </AreaChart>
  );
}

/**
 * The club's money by day. <b>Penalties are net</b> — see {@link minuteAxis} — so the series is
 * labelled as such, and the bar goes below the solid zero line on a reversal day.
 */
export function drawDailyFlow(data: DailyAdminPoint[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN} stackOffset="sign">
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis {...minuteYAxis(stackedExtremes(data, CLUB_FLOW_STACKS), c)} />
      <ReferenceLine y={0} stroke={c.muted} strokeWidth={1} />
      <Tooltip {...tooltipProps(c)} {...minutesTooltip} />
      <Legend {...legendProps(c)} />
      <Bar dataKey="top_ups_minutes" name="Minutes sold" stackId="a" fill={c.success} radius={[3, 3, 0, 0]} />
      <Bar dataKey="booking_charges_minutes" name="Bookings" stackId="b" fill={c.accent} radius={[3, 3, 0, 0]} />
      <Bar dataKey="penalties_minutes" name="Penalties (net)" stackId="b" fill={c.warning} radius={[3, 3, 0, 0]} />
    </BarChart>
  );
}

export function drawBookingsLine(data: DailyAdminPoint[], c: ChartPalette) {
  return (
    <LineChart data={data} margin={MARGIN}>
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis allowDecimals={false} {...axisProps(c)} width={COUNT_AXIS_WIDTH} />
      <Tooltip {...tooltipProps(c)} {...dateTooltip} />
      <Legend {...legendProps(c)} />
      <Line type="monotone" dataKey="bookings" name="Bookings" stroke={c.accent} strokeWidth={2} dot={false} />
      <Line type="monotone" dataKey="no_shows" name="No-shows" stroke={c.danger} strokeWidth={2} dot={false} />
    </LineChart>
  );
}

type CourtRevenue = { court_name: string; kept_minutes: number; bookings: number };

export function drawCourtsRevenue(data: CourtRevenue[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN}>
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="court_name" {...axisProps(c)} />
      <YAxis {...minuteYAxis(stackedExtremes(data, [["kept_minutes"]]), c)} />
      <Tooltip {...tooltipProps(c)} formatter={minutesTooltip.formatter} />
      <Bar dataKey="kept_minutes" name="Kept" fill={c.accent} radius={[6, 6, 0, 0]} />
    </BarChart>
  );
}

export function drawNoShowDonut(total: number, noShow: number, c: ChartPalette) {
  const showed = Math.max(0, total - noShow);
  const data = [
    { name: "Showed up", value: showed, color: c.success },
    { name: "No-shows", value: noShow, color: c.danger },
  ];
  return (
    <PieChart>
      <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={2} stroke="none">
        {data.map((d) => <Cell key={d.name} fill={d.color} />)}
      </Pie>
      <Tooltip {...tooltipProps(c)} />
      <Legend verticalAlign="bottom" {...legendProps(c)} />
    </PieChart>
  );
}

export function drawMyBalance(data: DailyMePoint[], c: ChartPalette) {
  return (
    <AreaChart data={data} margin={MARGIN}>
      {fillGradient("balFill", c.accent, 0.3)}
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis {...minuteYAxis(stackedExtremes(data, [["balance_minutes"]]), c)} />
      <Tooltip {...tooltipProps(c)} {...minutesTooltip} />
      <Area type="monotone" dataKey="balance_minutes" name="Balance" stroke={c.accent} fill="url(#balFill)" strokeWidth={2} />
    </AreaChart>
  );
}

/**
 * A member's own money by day. <b>Refunds are net</b> — see {@link minuteAxis}: a member whose
 * no-show was reversed a day later sees the refund taken back on the day the evidence landed.
 */
export function drawMyFlow(data: DailyMePoint[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN} stackOffset="sign">
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis {...minuteYAxis(stackedExtremes(data, MEMBER_FLOW_STACKS), c)} />
      <ReferenceLine y={0} stroke={c.muted} strokeWidth={1} />
      <Tooltip {...tooltipProps(c)} {...minutesTooltip} />
      <Legend {...legendProps(c)} />
      <Bar dataKey="top_ups_minutes" name="Bought" stackId="a" fill={c.success} radius={[3, 3, 0, 0]} />
      <Bar dataKey="refunds_minutes" name="Refunds (net)" stackId="a" fill={c.successSoft} radius={[3, 3, 0, 0]} />
      <Bar dataKey="spent_minutes" name="Spent" stackId="b" fill={c.accent} radius={[3, 3, 0, 0]} />
    </BarChart>
  );
}

/**
 * Bookings against attendance, per day. The second bar is `attended`, counted off
 * `CheckedInAt` — the at-court identification event, the source of truth for attendance — so a
 * gap between the bars is the days that cost a penalty.
 */
export function drawMyBookings(data: DailyMePoint[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN}>
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis allowDecimals={false} {...axisProps(c)} width={COUNT_AXIS_WIDTH} />
      <Tooltip {...tooltipProps(c)} {...dateTooltip} />
      <Legend {...legendProps(c)} />
      <Bar dataKey="bookings" name="Booked" fill={c.accentSoft} radius={[3, 3, 0, 0]} />
      <Bar dataKey="attended" name="Played" fill={c.accent} radius={[3, 3, 0, 0]} />
    </BarChart>
  );
}

export function RevenueAreaChart({ data }: { data: DailyAdminPoint[] }) {
  return <ChartFrame>{(c) => drawRevenueArea(data, c)}</ChartFrame>;
}

export function DailyFlowBarChart({ data }: { data: DailyAdminPoint[] }) {
  return <ChartFrame>{(c) => drawDailyFlow(data, c)}</ChartFrame>;
}

export function BookingsLineChart({ data }: { data: DailyAdminPoint[] }) {
  return <ChartFrame>{(c) => drawBookingsLine(data, c)}</ChartFrame>;
}

export function CourtsRevenueBarChart({ data }: { data: CourtRevenue[] }) {
  return <ChartFrame>{(c) => drawCourtsRevenue(data, c)}</ChartFrame>;
}

export function NoShowDonut({ total, noShow }: { total: number; noShow: number }) {
  return <ChartFrame>{(c) => drawNoShowDonut(total, noShow, c)}</ChartFrame>;
}

export function MyBalanceLineChart({ data }: { data: DailyMePoint[] }) {
  return <ChartFrame>{(c) => drawMyBalance(data, c)}</ChartFrame>;
}

export function MyFlowBarChart({ data }: { data: DailyMePoint[] }) {
  return <ChartFrame>{(c) => drawMyFlow(data, c)}</ChartFrame>;
}

export function MyBookingsBarChart({ data }: { data: DailyMePoint[] }) {
  return <ChartFrame>{(c) => drawMyBookings(data, c)}</ChartFrame>;
}
