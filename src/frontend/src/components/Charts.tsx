/* eslint-disable react-refresh/only-export-components -- the drawings (and the axis arithmetic) are exported for the tests that read their element trees; the components below wrap them. */
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ReferenceLine, Tooltip, XAxis, YAxis, Line, LineChart,
} from "recharts";
import { createElement } from "react";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { formatCredits } from "../lib/utils";
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
 * The narrowest y-axis gutter a credit-denominated axis is ever given — a FLOOR, not the answer.
 * The width each chart uses comes from {@link creditAxisWidth}, computed from its own data;
 * these series are net and go four figures negative, and no constant survives that.
 */
const CREDIT_AXIS_MIN_WIDTH = 64;

/**
 * The parts of a credit tick label, in pixels, measured in Chromium at 11px Figtree 400 with
 * `getComputedTextLength` ("0.00 cr" 35.83, "50.00 cr" 42.16, "-1000.00 cr" 59.06, "-8000.00 cr"
 * 61.28), then scaled to the {@link AXIS_FONT_PX} the axis is now set in — an outline font's
 * advance widths scale linearly with its size. Figtree's figures are proportional, so every
 * digit is costed as the widest one: {@link creditLabelWidth} is an upper bound, which is the
 * right side to be wrong on.
 */
const MEASURED_AT_PX = 11;
const SCALE = AXIS_FONT_PX / MEASURED_AT_PX;
const AXIS_WIDEST_DIGIT_PX = 7.07 * SCALE;
const AXIS_MINUS_PX = 4.6 * SCALE;
/** ".00 cr" — the tail every credit label carries, measured whole so its kerning is included. */
const AXIS_DECIMALS_AND_UNIT_PX = 28.79 * SCALE;

/**
 * What recharts keeps between the plot and the tick text: `tickSize` 6 plus `tickMargin` 2. A
 * left axis anchors its tick text at `x + width - 8` with `text-anchor: end`, so a label wider
 * than `width - 8` starts left of the chart's own box — under the carousel's Previous arrow.
 */
const AXIS_TICK_GAP_PX = 8;

/** The gutter for an axis of plain integers — "12" needs nothing like the room "50.00 cr" does. */
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

// Credits, not rand. These charts plot ledger movements and court spend, both of
// which are credit-denominated — a rand sign here overstates every bar by the
// conversion rate.
const fmtCredits = (v: number | string) => formatCredits(Number(v));

/**
 * U+00A0, written as an escape on purpose: a literal non-breaking space in source is invisible,
 * and an editor that normalises whitespace would silently put every credit tick back onto two
 * lines.
 */
const NON_BREAKING_SPACE = "\u00a0";

/**
 * The same figure for an axis tick, with the space before the unit made non-breaking.
 *
 * <p>
 * recharts decides whether a tick fits by measuring its words in a hidden span that inherits
 * the BODY's font size, not the axis's, and breaks the label accordingly — "100.00" above "cr".
 * A label with no breaking space in it is one word, and recharts never breaks a word. Not
 * applied to {@link fmtCredits}: a tooltip is laid out in HTML and its text is copied by people.
 * </p>
 */
const fmtAxisCredits = (v: number | string) => formatCredits(Number(v)).replace(" ", NON_BREAKING_SPACE);

/** The width of the widest label an axis reaching `value` can draw, in pixels. Upper bound. */
function creditLabelWidth(value: number): number {
  const digits = String(Math.floor(Math.abs(value))).length;
  const sign = 0 > value ? AXIS_MINUS_PX : 0;
  return sign + digits * AXIS_WIDEST_DIGIT_PX + AXIS_DECIMALS_AND_UNIT_PX;
}

/**
 * A value rounded AWAY from zero to the next multiple of its own leading power of ten. The axis
 * labels its ticks, not the data, and recharts picks round ones past the extreme: a series
 * topping out at 950 is drawn with a tick at 1000, one digit wider than anything in the data.
 */
function niceAway(value: number): number {
  if (value === 0) return 0;
  const magnitude = Math.abs(value);
  const step = 10 ** Math.max(0, Math.floor(Math.log10(magnitude)));
  return Math.sign(value) * Math.ceil(magnitude / step) * step;
}

/**
 * The gutter a credit y-axis needs for the widest label its own data can produce. Exported so
 * `chart-geometry.test.tsx` can rebuild the expectation from the series each chart declares.
 * Zero is always in the range, because every one of these axes draws a zero line.
 */
export function creditAxisWidth(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  const widest = Math.max(
    creditLabelWidth(niceAway(Math.min(0, ...finite))),
    creditLabelWidth(niceAway(Math.max(0, ...finite))),
  );
  return Math.max(CREDIT_AXIS_MIN_WIDTH, Math.ceil(widest) + AXIS_TICK_GAP_PX);
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
const CLUB_FLOW_STACKS = [["top_ups_credits"], ["booking_charges_credits", "penalties_credits"]];
const MEMBER_FLOW_STACKS = [["top_ups_credits", "refunds_credits"], ["spent_credits"]];
/** F4-15 — the axis in the club's format ("1 Sep"), not the reader's locale ("Sep 01"). */
const fmtDate = (d: string) => clubCalendarDate(d, { weekday: false });

/**
 * The y-axis floor for a chart plotting ledger movements: zero, or below it exactly as far as
 * the data goes. These series are <b>net</b> (settlement-model I11 posts every correction as a
 * new opposite-sign row), so a day can be negative. recharts' default `[0, 'auto']` survives a
 * negative only through an implementation detail; saying the floor out loud cannot regress.
 */
export const signedFloor = (dataMin: number) => (Number.isFinite(dataMin) ? Math.min(0, Math.floor(dataMin)) : 0);

/** {@link signedFloor} as a recharts y-domain: signed floor, auto ceiling. */
export const SIGNED_DOMAIN = [signedFloor, "auto"] as const;

const creditTooltip = { formatter: ((v: number) => fmtCredits(v)) as never, labelFormatter: ((l: string) => fmtDate(l)) as never };
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
      <YAxis tickFormatter={fmtAxisCredits} {...axisProps(c)} width={creditAxisWidth(stackedExtremes(data, [["top_ups_credits"]]))} />
      <Tooltip {...tooltipProps(c)} {...creditTooltip} />
      <Area type="monotone" dataKey="top_ups_credits" name="Top-ups" stroke={c.accent} fill="url(#revFill)" strokeWidth={2} />
    </AreaChart>
  );
}

/**
 * The club's money by day. <b>Penalties are net</b> — see {@link signedFloor} — so the series is
 * labelled as such, and the bar goes below the solid zero line on a reversal day.
 */
export function drawDailyFlow(data: DailyAdminPoint[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN} stackOffset="sign">
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis tickFormatter={fmtAxisCredits} {...axisProps(c)} width={creditAxisWidth(stackedExtremes(data, CLUB_FLOW_STACKS))} domain={SIGNED_DOMAIN} />
      <ReferenceLine y={0} stroke={c.muted} strokeWidth={1} />
      <Tooltip {...tooltipProps(c)} {...creditTooltip} />
      <Legend {...legendProps(c)} />
      <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={c.success} radius={[3, 3, 0, 0]} />
      <Bar dataKey="booking_charges_credits" name="Bookings" stackId="b" fill={c.accent} radius={[3, 3, 0, 0]} />
      <Bar dataKey="penalties_credits" name="Penalties (net)" stackId="b" fill={c.warning} radius={[3, 3, 0, 0]} />
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

type CourtRevenue = { court_name: string; revenue_credits: number; bookings: number };

export function drawCourtsRevenue(data: CourtRevenue[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN}>
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="court_name" {...axisProps(c)} />
      <YAxis tickFormatter={fmtAxisCredits} {...axisProps(c)} width={creditAxisWidth(stackedExtremes(data, [["revenue_credits"]]))} />
      <Tooltip {...tooltipProps(c)} formatter={creditTooltip.formatter} />
      <Bar dataKey="revenue_credits" name="Revenue" fill={c.accent} radius={[6, 6, 0, 0]} />
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
      <YAxis tickFormatter={fmtAxisCredits} {...axisProps(c)} width={creditAxisWidth(stackedExtremes(data, [["balance_credits"]]))} />
      <Tooltip {...tooltipProps(c)} {...creditTooltip} />
      <Area type="monotone" dataKey="balance_credits" name="Balance" stroke={c.accent} fill="url(#balFill)" strokeWidth={2} />
    </AreaChart>
  );
}

/**
 * A member's own money by day. <b>Refunds are net</b> — see {@link signedFloor}: a member whose
 * no-show was reversed a day later sees the refund taken back on the day the evidence landed.
 */
export function drawMyFlow(data: DailyMePoint[], c: ChartPalette) {
  return (
    <BarChart data={data} margin={MARGIN} stackOffset="sign">
      <CartesianGrid strokeDasharray="3 3" stroke={c.grid} vertical={false} />
      <XAxis dataKey="date" tickFormatter={fmtDate} {...axisProps(c)} />
      <YAxis tickFormatter={fmtAxisCredits} {...axisProps(c)} width={creditAxisWidth(stackedExtremes(data, MEMBER_FLOW_STACKS))} domain={SIGNED_DOMAIN} />
      <ReferenceLine y={0} stroke={c.muted} strokeWidth={1} />
      <Tooltip {...tooltipProps(c)} {...creditTooltip} />
      <Legend {...legendProps(c)} />
      <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={c.success} radius={[3, 3, 0, 0]} />
      <Bar dataKey="refunds_credits" name="Refunds (net)" stackId="a" fill={c.successSoft} radius={[3, 3, 0, 0]} />
      <Bar dataKey="spent_credits" name="Spent" stackId="b" fill={c.accent} radius={[3, 3, 0, 0]} />
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
