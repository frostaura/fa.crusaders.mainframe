import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Line, LineChart,
} from "recharts";
import { createElement, useEffect, useRef, useState } from "react";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { formatCredits } from "../lib/utils";
import { chartColors } from "../lib/tokens";

/**
 * The chart palette, from the token module rather than from a copy.
 *
 * <p>
 * These eight names used to be eight hex literals declared here, and three of them had gone
 * stale without anything saying so. `ACCENT` was `#0369A1` — the sky-blue this product moved off
 * when it adopted the club's crest colours — so every chart rendered in an accent that appeared
 * nowhere else on the page around it. `ACCENT_SOFT` was that dead palette's tint. `TEXT_MUTED`
 * was `#6B7280` against a token of `#5B6879`, two greys nobody chose to be different. Beyond
 * these, the gridlines and the tooltip border were `#E5E7EB` inline, a fourth grey that is
 * neither the border token nor the muted one.
 * </p>
 *
 * <p>
 * Resolved once at module load, which is after `index.css` has applied, so `ACCENT` follows a
 * tenant override exactly as a `bg-accent-strong` class would.
 * </p>
 */
const {
  accent: ACCENT,
  accentSoft: ACCENT_SOFT,
  success: SUCCESS,
  successSoft: SUCCESS_SOFT,
  warning: WARNING,
  danger: DANGER,
  muted: TEXT_MUTED,
  legend: LEGEND_TEXT,
  grid: GRID,
} = chartColors();

const CHART_HEIGHT = 240;

/**
 * The height reserved above the plot for the topmost y-axis tick.
 *
 * <p>
 * At 8px the top label was sliced in half by the SVG's own edge — "50.00 cr" rendered as a row
 * of half-height digits above an intact "45.00 cr", which reads as a rendering fault rather than
 * as a number. A tick is centred on its gridline, so the margin has to clear half a line of text
 * at the 11px the axis is set in.
 * </p>
 */
const TOP_MARGIN = 16;

/**
 * The narrowest y-axis gutter a credit-denominated axis is ever given.
 *
 * <p>
 * 48 was under the width of "50.00 cr" at 11px, and recharts wraps a tick that does not fit
 * rather than overflowing it — so every single tick on the wallet-balance chart rendered on two
 * lines, doubling the label column's height and pushing the top one into the clip described
 * above. Counts ({@link COUNT_AXIS_WIDTH}) are short enough not to need it.
 * </p>
 *
 * <p>
 * <b>It is now a FLOOR rather than the answer.</b> 64 was measured against "50.00 cr" and then
 * shipped as a constant for every credit axis in the product, which is the whole defect: these
 * series are net, net goes four figures negative on any day whose penalty rows reverse an
 * earlier sweep, and no constant chosen against one label survives the next wider one. The
 * width each chart actually uses comes from {@link creditAxisWidth}, computed from its own
 * data. This value stays as the lower bound so that a chart whose numbers are small keeps the
 * gutter that was measured right for it, instead of reclaiming a few pixels of plot on the
 * strength of the same arithmetic that is being introduced to widen the others.
 * </p>
 */
const CREDIT_AXIS_MIN_WIDTH = 64;

/**
 * The parts of a credit tick label, in pixels, <b>measured in Chromium</b> at the 11px Figtree
 * 400 the axis is drawn in — not estimated from character counts, which is how 64 was arrived
 * at. `getComputedTextLength` on the rendered ticks: "0.00 cr" 35.83, "50.00 cr" 42.16,
 * "-1000.00 cr" 59.06, "-8000.00 cr" 61.28.
 *
 * <p>
 * Figtree's figures are proportional, not tabular — "0" is 7.06px and "1" is 4.55px — so a
 * label's width depends on which digits are in it. The widest digit is used for all of them,
 * which makes {@link creditLabelWidth} an upper bound for any number of that many digits: 61.67
 * against a real "-8000.00 cr" of 61.28. An upper bound is the right side to be wrong on, and
 * it also means an intermediate tick can never need more room than the extreme one that sized
 * the axis.
 * </p>
 */
const AXIS_WIDEST_DIGIT_PX = 7.07;
const AXIS_MINUS_PX = 4.6;
/** ".00 cr" — the tail every credit label carries, measured whole so its kerning is included. */
const AXIS_DECIMALS_AND_UNIT_PX = 28.79;

/**
 * What recharts keeps between the plot and the tick text: `tickSize` 6 plus `tickMargin` 2.
 *
 * A left axis anchors its tick text at `x + width - tickSize - tickMargin` with `text-anchor:
 * end`, so a label wider than `width - 8` starts to the left of the chart's own box — which is
 * where the carousel's Previous arrow sits, and is the collision {@link LEFT_MARGIN} records.
 */
const AXIS_TICK_GAP_PX = 8;

/** The same gutter for an axis of plain integers — "12" needs nothing like the room "50.00 cr" does. */
const COUNT_AXIS_WIDTH = 36;

/**
 * The left margin. Zero, not negative.
 *
 * <p>
 * <code>left: -12</code> bought a little plot width by pulling the axis labels 12px outside the
 * chart's own box — straight underneath the carousel's Previous arrow, which sits at the
 * container's left edge less 12px. The arrow landed on top of the tick labels. The gutter above
 * is what recovers the space, honestly, inside the box.
 * </p>
 */
const LEFT_MARGIN = 0;

/**
 * The measured width of a {@link ChartFrame}'s box.
 *
 * A named alias rather than an inline `useState<{ width: number } | null>`, and that is not
 * style: lizard's TSX parser reads the `<` of the generic as a JSX open tag and then swallows the
 * rest of the file into whichever function it was last inside — it reported `ChartFrame` at 243
 * lines and lost every function after it, tripping `make complexity`'s `-L 200` on lines nobody
 * had touched. Naming the type puts the braces outside the angle brackets. See memory/gotchas.md.
 */
type FrameSize = { width: number };

/**
 * The box a chart is drawn in, which does not draw the chart until the box has a size.
 *
 * <p>
 * recharts' <code>ResponsiveContainer</code> measures its parent and, when it cannot, renders
 * nothing and logs <i>"The width(-1) and height(-1) of chart should be greater than 0"</i>. On
 * /reports that happened sixteen times per page load: the report charts live in a carousel whose
 * off-screen slides are laid out at zero width, so every chart that was not the visible slide
 * measured -1 and complained. The charts themselves were fine — they render the moment their
 * slide is scrolled to.
 * </p>
 *
 * <p>
 * Sixteen warnings a load is not a cosmetic problem. /reports is the one screen an admin opens
 * when they think something is wrong, and a console that is already full of red is a console
 * nobody reads the seventeenth line of.
 * </p>
 *
 * <p>
 * Holding the chart back until the box is measurable removes the warning at its cause rather
 * than silencing it, and costs nothing visible: a slide with no width has nothing to show
 * anyway. The height is fixed, so only the width is ever in question.
 * </p>
 *
 * <p>
 * <b>The gate alone was not enough, and the round-1 claim above was false as written.</b> A
 * headed pass counted <i>six warnings per /reports load</i> at the same moment all three frames
 * reported <code>data-measurable="true"</code> and <code>clientWidth: 950</code> — so the gate
 * was open and the complaint was coming from inside <code>ResponsiveContainer</code> anyway.
 * It defaults <code>initialDimension</code> to <code>{-1, -1}</code> and warns on its very first
 * render, before its own ResizeObserver has had a chance to run; no parent can prevent that by
 * being the right size, because the parent is not what it reads on that render. jsdom has no
 * layout, so the round-1 test never got the frame measurable and never reached the render that
 * warns — it passed while the defect was untouched. Handing the container the width the frame
 * has already measured is what closes it: the first render is a real size, and there is no
 * frame with nothing in it to warn about.
 * </p>
 *
 * <p>
 * Worth knowing before deciding this is a development-only annoyance: recharts' own
 * <code>LogUtils</code> hard-codes <code>isDev = true</code> in the published build, so these
 * warnings fire in production too.
 * </p>
 */
function ChartFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Null until the box has a width; the width it FIRST had once it does. Only the first positive
  // measurement is kept, because after that `ResponsiveContainer`'s own ResizeObserver owns the
  // size — re-rendering the chart on every pixel of a window drag would buy nothing. The state
  // therefore changes only on a null↔sized transition.
  const [frame, setFrame] = useState<FrameSize | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // `width > 0`, never `width <= 0`: lizard reads a bare `<` in a .tsx file as a JSX open tag
    // and swallows the rest of the file into whichever function it was last inside, reporting
    // this one at 268 lines and tripping `-L 200` on a line nobody touched. See memory/gotchas.md.
    const check = () => {
      const width = el.clientWidth;
      setFrame((previous) => (width > 0 ? previous ?? { width } : null));
    };
    check();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", check);
      return () => window.removeEventListener("resize", check);
    }
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ height: CHART_HEIGHT }} data-testid="chart-frame" data-measurable={frame !== null}>
      {frame && (
        <ResponsiveContainer initialDimension={{ width: frame.width, height: CHART_HEIGHT }}>
          {children as React.ReactElement}
        </ResponsiveContainer>
      )}
    </div>
  );
}


const tooltipStyle = {
  contentStyle: { borderRadius: 8, border: `1px solid ${GRID}`, fontSize: 12, padding: "6px 10px" },
  labelStyle: { color: TEXT_MUTED, fontWeight: 500, marginBottom: 2 },
} as const;

/**
 * A legend whose labels can be read.
 *
 * <p>
 * recharts paints each legend label in that series' own colour. Three of the five labels on
 * /reports used a <code>*-strong</code> token and were fine; the two that used the series
 * <i>fill</i> — "Refunds (net)" on <code>success.soft</code> and "Booked" on
 * <code>accent.soft</code> — measured <b>1.10:1 and 1.15:1 on white</b>. Those are pale ghosts
 * beside a legible neighbour, against the 4.5:1 floor `docs/specs/design-system.md` commits to,
 * and there is only one theme, so there is nowhere for them to become readable.
 * </p>
 *
 * <p>
 * The fix is not to darken the two fills: a soft fill next to a strong one is the whole point of
 * the pairing, and "Booked" being lighter than "Played" is what makes the gap between the bars
 * legible. The label is a different job from the swatch. The swatch keeps the series colour and
 * carries the identification; the text is set in <code>text.primary</code> like every other
 * label in the product, and a `formatter` is the only hook recharts offers for it.
 * </p>
 *
 * <p>
 * Applied through one shared object rather than per chart, for the reason the whole affordance
 * layer in <code>index.css</code> exists: a rule applied per component is one a new component
 * silently does not get, and that is precisely how two of these five ended up wrong.
 * </p>
 */
const legendProps = {
  wrapperStyle: { fontSize: 11 },
  // `createElement`, not JSX. lizard reads a bare `<` in a .tsx file as a JSX open tag and
  // swallows the rest of the file into whichever function it was last inside — this one-line
  // arrow was reported at 145 lines and dragged ChartFrame to 268, tripping `-L 200` on lines
  // nobody had touched. See memory/gotchas.md.
  formatter: (value: string) => createElement("span", { style: { color: LEGEND_TEXT } }, value),
} as const;

// Credits, not rand. These charts plot ledger movements and court spend, both of
// which are credit-denominated — a rand sign here overstates every bar by the
// conversion rate.
const fmtCredits = (v: number | string) => formatCredits(Number(v));

/**
 * U+00A0, written as an escape on purpose: a literal non-breaking space in source is
 * invisible, survives no copy-paste reliably, and an editor that helpfully normalises
 * whitespace would silently put every credit tick back onto two lines.
 */
const NON_BREAKING_SPACE = "\u00a0";

/**
 * The same figure for an axis tick, with the space before the unit made non-breaking.
 *
 * <p>
 * <b>This is not typography. It is what stops every credit tick above 99 rendering on two
 * lines.</b> recharts decides whether a tick fits by splitting it on spaces and measuring the
 * words with `getStringSize`, which puts them in a hidden `span` appended to `document.body` —
 * a span that inherits the BODY's 16px, while the tick itself is drawn at the axis's 11px. It
 * was therefore judging every label about 45% wider than it draws, and breaking it accordingly:
 * measured in Chromium at the shipped 64px gutter, "100.00 cr" came out as "100.00" above "cr",
 * and so did 150, 200 and every four-figure negative. The unit column doubled in height and the
 * topmost tick went into the SVG's clip — the exact fault {@link TOP_MARGIN} was added to fix,
 * arriving by a different route.
 * </p>
 *
 * <p>
 * A label with no breaking space in it is one word, and recharts never breaks a word: the
 * mis-measurement stops being able to express itself, whatever font size it thinks it is
 * working in. What remains is the honest question of whether the label FITS, which
 * {@link creditAxisWidth} answers from the data. The character is U+00A0, so the rendered text
 * is identical to a reader and to a screenshot; only the line-breaking opportunity is gone.
 * </p>
 *
 * <p>
 * Deliberately not applied to {@link fmtCredits}, which the tooltips use: a tooltip is laid out
 * in HTML, has no gutter to overflow, and its text is matched by tests and read by people who
 * may copy it.
 * </p>
 */
const fmtAxisCredits = (v: number | string) => formatCredits(Number(v)).replace(" ", NON_BREAKING_SPACE);

/**
 * The width of the widest label an axis reaching `value` can draw, in pixels.
 *
 * Upper bound, by construction: every digit is costed as the widest one in the face. See the
 * metric constants above for where the numbers come from and why they are measured rather than
 * counted.
 */
function creditLabelWidth(value: number): number {
  const digits = String(Math.floor(Math.abs(value))).length;
  const sign = 0 > value ? AXIS_MINUS_PX : 0;
  return sign + digits * AXIS_WIDEST_DIGIT_PX + AXIS_DECIMALS_AND_UNIT_PX;
}

/**
 * A value rounded AWAY from zero to the next multiple of its own leading power of ten.
 *
 * <p>
 * The axis does not label the data; it labels the ticks, and recharts picks round ones that
 * reach past the extreme value. A series topping out at 950 is drawn with a tick at 1000 —
 * one digit wider than anything in the data — so sizing the gutter from the data alone
 * under-fits it by exactly one character on precisely the series that were about to overflow
 * anyway. This is a deliberate over-estimate of where the tick lands rather than a
 * reimplementation of recharts' tick algorithm: it is never narrower than the real top tick,
 * and it only ever changes the answer at a digit boundary, which is the only place the answer
 * changes at all.
 * </p>
 */
function niceAway(value: number): number {
  if (value === 0) return 0;
  const magnitude = Math.abs(value);
  const step = 10 ** Math.max(0, Math.floor(Math.log10(magnitude)));
  return Math.sign(value) * Math.ceil(magnitude / step) * step;
}

/**
 * The gutter a credit y-axis needs for the widest label its own data can produce.
 *
 * <p>
 * Exported so `chart-geometry.test.tsx` can rebuild the expectation from the series each chart
 * declares rather than restating them — the one drift this design can suffer is a `Bar` added
 * to a chart and not to the list of keys its width is computed from.
 * </p>
 *
 * <p>
 * Zero is always in the range, because every one of these axes draws a zero line.
 * </p>
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
 * The values a stacked signed chart's y-axis has to reach.
 *
 * <p>
 * Not the largest single bar: `stackOffset="sign"` accumulates a stack's positives upward and
 * its negatives downward, so a day's reach is the sum of each sign within each stack. A chart
 * with no stacks passes one key per group and gets the values themselves back.
 * </p>
 *
 * <p>
 * The comparisons are written `0 > v` rather than `v < 0` for the reason recorded on
 * {@link ChartFrame}: lizard reads a bare `<` in a .tsx file as a JSX open tag and swallows the
 * rest of the file into whichever function it was last inside.
 * </p>
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

/**
 * Which series share a stack, per chart — mirroring the `stackId`s on the bars below.
 *
 * The geometry test reads the real ones off the rendered elements and checks the width against
 * them, so these cannot fall out of step with the chart without a test failing.
 */
const CLUB_FLOW_STACKS = [["top_ups_credits"], ["booking_charges_credits", "penalties_credits"]];
const MEMBER_FLOW_STACKS = [["top_ups_credits", "refunds_credits"], ["spent_credits"]];
const fmtDate = (d: string) => {
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
};

/**
 * The y-axis floor for a chart plotting ledger movements: zero, or below it exactly as
 * far as the data goes.
 *
 * <p>
 * These series are <b>net</b>, and net means a day can be negative. Settlement-model
 * I11 posts every correction as a new row of the same type with the opposite sign
 * rather than editing the original, and a reversal routinely lands in a different day's
 * bucket from the sweep it reverses — so a day whose only penalty row is a reversal
 * reads as a negative penalty. The API is right; the chart has to be able to draw it.
 * </p>
 *
 * <p>
 * Recharts' default numeric domain is <code>[0, 'auto']</code>, which reads as a floor
 * at zero. It survives a negative today only because <code>extendDomain</code> widens a
 * user domain to the data rather than clipping to it — an implementation detail of the
 * version in <code>package.json</code>, not a contract. Saying the floor out loud costs
 * one prop and cannot regress quietly. <code>Math.floor</code> leaves the bar a little
 * room instead of ending the axis exactly on the most negative value.
 * </p>
 */
export const signedFloor = (dataMin: number) => (Number.isFinite(dataMin) ? Math.min(0, Math.floor(dataMin)) : 0);

/** {@link signedFloor} as a recharts y-domain: signed floor, auto ceiling. */
export const SIGNED_DOMAIN = [signedFloor, "auto"] as const;

/**
 * The zero line is drawn solid on the signed charts, so a bar hanging under it reads as
 * a reversal rather than as a mis-drawn bar. The grid's own line at zero is dashed and
 * the same weight as every other tick, which is exactly wrong on a chart where the sign
 * is the information. Written inline at each call site rather than wrapped in a
 * component: recharts discovers its own elements, and a wrapper is a needless bet on how.
 */
const ZERO_LINE_STROKE = TEXT_MUTED;

export function RevenueAreaChart({ data }: { data: DailyAdminPoint[] }) {
  return (
    <ChartFrame>
        <AreaChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }}>
          <defs>
            <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.4} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtAxisCredits} fontSize={11} stroke={TEXT_MUTED} width={creditAxisWidth(stackedExtremes(data, [["top_ups_credits"]]))} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Area type="monotone" dataKey="top_ups_credits" name="Top-ups" stroke={ACCENT} fill="url(#revFill)" strokeWidth={2} />
        </AreaChart>
    </ChartFrame>
  );
}

/**
 * The club's money by day. <b>Penalties are net</b> — see {@link signedFloor} — so the
 * series is labelled as such in the legend and the tooltip, and the bar goes below the
 * zero line on a day whose penalty rows are reversals of an earlier day's sweep.
 */
export function DailyFlowBarChart({ data }: { data: DailyAdminPoint[] }) {
  return (
    <ChartFrame>
        <BarChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtAxisCredits} fontSize={11} stroke={TEXT_MUTED} width={creditAxisWidth(stackedExtremes(data, CLUB_FLOW_STACKS))} domain={SIGNED_DOMAIN} />
          <ReferenceLine y={0} stroke={ZERO_LINE_STROKE} strokeWidth={1} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend {...legendProps} />
          <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={SUCCESS} radius={[3, 3, 0, 0]} />
          <Bar dataKey="booking_charges_credits" name="Bookings" stackId="b" fill={ACCENT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="penalties_credits" name="Penalties (net)" stackId="b" fill={WARNING} radius={[3, 3, 0, 0]} />
        </BarChart>
    </ChartFrame>
  );
}

export function BookingsLineChart({ data }: { data: DailyAdminPoint[] }) {
  return (
    <ChartFrame>
        <LineChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis allowDecimals={false} fontSize={11} stroke={TEXT_MUTED} width={COUNT_AXIS_WIDTH} />
          <Tooltip {...tooltipStyle} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend {...legendProps} />
          <Line type="monotone" dataKey="bookings" name="Bookings" stroke={ACCENT} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="no_shows" name="No-shows" stroke={DANGER} strokeWidth={2} dot={false} />
        </LineChart>
    </ChartFrame>
  );
}

export function CourtsRevenueBarChart({ data }: { data: { court_name: string; revenue_credits: number; bookings: number }[] }) {
  return (
    <ChartFrame>
        <BarChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="court_name" fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtAxisCredits} fontSize={11} stroke={TEXT_MUTED} width={creditAxisWidth(stackedExtremes(data, [["revenue_credits"]]))} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} />
          <Bar dataKey="revenue_credits" name="Revenue" fill={ACCENT} radius={[6, 6, 0, 0]} />
        </BarChart>
    </ChartFrame>
  );
}

export function NoShowDonut({ total, noShow }: { total: number; noShow: number }) {
  const showed = Math.max(0, total - noShow);
  const data = [
    { name: "Showed up", value: showed, color: SUCCESS },
    { name: "No-shows", value: noShow, color: DANGER },
  ];
  return (
    <ChartFrame>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={2} stroke="none">
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
          <Tooltip {...tooltipStyle} />
          <Legend verticalAlign="bottom" {...legendProps} />
        </PieChart>
    </ChartFrame>
  );
}

export function MyBalanceLineChart({ data }: { data: DailyMePoint[] }) {
  return (
    <ChartFrame>
        <AreaChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }}>
          <defs>
            <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtAxisCredits} fontSize={11} stroke={TEXT_MUTED} width={creditAxisWidth(stackedExtremes(data, [["balance_credits"]]))} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Area type="monotone" dataKey="balance_credits" name="Balance" stroke={ACCENT} fill="url(#balFill)" strokeWidth={2} />
        </AreaChart>
    </ChartFrame>
  );
}

/**
 * A member's own money by day. <b>Refunds are net</b> — see {@link signedFloor}. A member
 * whose no-show was reversed a day later sees the refund the sweep gave them taken back
 * on the day the box's evidence landed, which is a negative refund on that day and is
 * exactly what happened to them.
 */
export function MyFlowBarChart({ data }: { data: DailyMePoint[] }) {
  return (
    <ChartFrame>
        <BarChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtAxisCredits} fontSize={11} stroke={TEXT_MUTED} width={creditAxisWidth(stackedExtremes(data, MEMBER_FLOW_STACKS))} domain={SIGNED_DOMAIN} />
          <ReferenceLine y={0} stroke={ZERO_LINE_STROKE} strokeWidth={1} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend {...legendProps} />
          <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={SUCCESS} radius={[3, 3, 0, 0]} />
          <Bar dataKey="refunds_credits" name="Refunds (net)" stackId="a" fill={SUCCESS_SOFT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="spent_credits" name="Spent" stackId="b" fill={ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
    </ChartFrame>
  );
}

/**
 * Bookings against attendance, per day.
 *
 * <p>
 * The second bar is <code>attended</code>, counted off <code>CheckedInAt</code> — the
 * at-court identification event, which `CLAUDE.md` makes the source of truth for
 * attendance and which settlement-model S4/S5 hang the refund and the no-show penalty
 * on. Nothing in the product rendered it anywhere: a slot a member turned up and played
 * drew character-for-character the same as one she was swept as a no-show for and
 * charged a penalty over, and this was the only screen with the data on hand to tell
 * them apart. A gap between the bars is the days that cost her a penalty.
 * </p>
 */
export function MyBookingsBarChart({ data }: { data: DailyMePoint[] }) {
  return (
    <ChartFrame>
        <BarChart data={data} margin={{ top: TOP_MARGIN, right: 8, bottom: 0, left: LEFT_MARGIN }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis allowDecimals={false} fontSize={11} stroke={TEXT_MUTED} width={COUNT_AXIS_WIDTH} />
          <Tooltip {...tooltipStyle} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend {...legendProps} />
          <Bar dataKey="bookings" name="Booked" fill={ACCENT_SOFT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="attended" name="Played" fill={ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
    </ChartFrame>
  );
}

// Re-export the soft palette so call-sites don't need to know recharts.
export const ChartColors = { ACCENT, ACCENT_SOFT, SUCCESS, WARNING, DANGER };
