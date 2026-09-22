import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Line, LineChart,
} from "recharts";
import { createElement, useEffect, useRef, useState } from "react";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { formatMoney } from "../lib/utils";
import { clubCurrencySymbol } from "../lib/currency";
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
 * at the 11px the axis is set in. Unchanged by the move to a leading symbol: what this clears is
 * half a LINE, and a line is the same height whatever is written on it.
 * </p>
 */
const TOP_MARGIN = 16;

/** The font size every y-axis on this page is set in. The widths below are derived at it. */
const AXIS_FONT_PX = 11;

/**
 * Widths at {@link AXIS_FONT_PX}, as fractions of the em — the arithmetic behind the gutter.
 *
 * <p>
 * <b>Written down rather than folded into a constant, because the constant it replaces was
 * wrong the moment the unit became configurable.</b> 64 was measured against "50.00 cr" and is
 * carried nowhere near a symbol a club can change. `SYMBOL` is deliberately the width of an
 * UPPERCASE LETTER, which is the widest thing `isAcceptableCurrencySymbol` admits: "CHF" and
 * "US$" are letters, where "€", "£" and "₹" are all narrower, so budgeting a letter per
 * character is an over-estimate for every currency sign and an exact one for the worst case.
 * </p>
 */
const DIGIT_PX = 0.55 * AXIS_FONT_PX;
const POINT_PX = 0.26 * AXIS_FONT_PX;
const SIGN_PX = 0.33 * AXIS_FONT_PX;
const SYMBOL_CHAR_PX = 0.75 * AXIS_FONT_PX;

/** recharts' own `tickSize` (6) plus `tickMargin` (3), which live inside the axis width. */
const TICK_GAP_PX = 9;

/**
 * The widest NUMBER these axes draw: four integer digits, a point and two decimals.
 *
 * <p>
 * Not a guess at the data — it is the bound the old constant was implicitly derived at. 64px
 * less the 9px tick gap leaves 55px, and "1000.00 cr" needs about 52 of them, so four integer
 * digits is exactly where the photographed fix stopped. A club whose daily revenue reaches five
 * figures will wrap a tick, as it would have done before this change; that is a known edge and
 * not a regression introduced here.
 * </p>
 */
const WIDEST_NUMBER_PX = 6 * DIGIT_PX + POINT_PX;

/**
 * The y-axis gutter, in pixels, for a money-denominated axis — <b>derived from the club's own
 * symbol, because it is no longer a property of this file.</b>
 *
 * <p>
 * The failure this protects against is unchanged and is worth restating, because it is not the
 * obvious one: recharts <b>wraps</b> a tick that does not fit rather than overflowing it. So a
 * gutter that is too narrow does not produce a clipped label — it produces every tick on two
 * lines, which doubles the label column's height and pushes the topmost one into the clip
 * {@link TOP_MARGIN} exists to prevent. That is what 48px did to the wallet-balance chart.
 * </p>
 *
 * <p>
 * The move to a leading symbol made the default club's label NARROWER — "R50.00" against
 * "50.00 cr" — and a club on "CHF" WIDER. A single constant cannot be right for both, and the
 * one that is right for the default is the one that silently wraps for everybody else. Rounded
 * up to a multiple of 4 so the gutter lands on the layout's own step rather than on a fraction
 * of a pixel.
 * </p>
 *
 * <p>
 * At one character this comes out at exactly 64 — the number a real browser confirmed — which
 * is a check on the arithmetic rather than a coincidence worth relying on; `chart-geometry.test.tsx`
 * pins it as a floor either way.
 * </p>
 */
export function moneyAxisWidth(symbol: string = clubCurrencySymbol()): number {
  const needed = TICK_GAP_PX + SIGN_PX + WIDEST_NUMBER_PX + SYMBOL_CHAR_PX * symbol.length;
  return Math.ceil(needed / 4) * 4;
}

/** The same gutter for an axis of plain integers — "12" needs nothing like the room "R50.00" does. */
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

// One unit, and it is the club's. This comment used to read "credits, not rand" and warned
// that a rand sign here would overstate every bar by the conversion rate — which was true
// while the two were written differently. The owner has collapsed them: a court price, a
// wallet and a card payment are all written with the club's symbol now, and `lib/currency.ts`
// carries the ruling and the residual risk it accepts. The only rule left for this file is
// that the unit comes from `formatMoney` rather than being composed beside a `toFixed`.
const fmtMoney = (v: number | string) => formatMoney(Number(v));
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
          <YAxis tickFormatter={fmtMoney} fontSize={11} stroke={TEXT_MUTED} width={moneyAxisWidth()} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtMoney(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
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
          <YAxis tickFormatter={fmtMoney} fontSize={11} stroke={TEXT_MUTED} width={moneyAxisWidth()} domain={SIGNED_DOMAIN} />
          <ReferenceLine y={0} stroke={ZERO_LINE_STROKE} strokeWidth={1} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtMoney(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
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
          <YAxis tickFormatter={fmtMoney} fontSize={11} stroke={TEXT_MUTED} width={moneyAxisWidth()} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtMoney(v)) as never} />
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
          <YAxis tickFormatter={fmtMoney} fontSize={11} stroke={TEXT_MUTED} width={moneyAxisWidth()} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtMoney(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
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
          <YAxis tickFormatter={fmtMoney} fontSize={11} stroke={TEXT_MUTED} width={moneyAxisWidth()} domain={SIGNED_DOMAIN} />
          <ReferenceLine y={0} stroke={ZERO_LINE_STROKE} strokeWidth={1} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtMoney(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
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
