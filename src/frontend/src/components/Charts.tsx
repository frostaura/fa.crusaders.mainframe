import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Line, LineChart,
} from "recharts";
import type { DailyAdminPoint, DailyMePoint } from "../lib/api";
import { formatCredits } from "../lib/utils";

const ACCENT = "#0369A1";        // accent-strong
const ACCENT_SOFT = "#E0F2FE";    // accent-soft
const SUCCESS = "#15803D";
const SUCCESS_SOFT = "#DCFCE7";
const WARNING = "#A16207";
const DANGER = "#B91C1C";
const TEXT_MUTED = "#6B7280";

const CHART_HEIGHT = 240;

const tooltipStyle = {
  contentStyle: { borderRadius: 8, border: "1px solid #E5E7EB", fontSize: 12, padding: "6px 10px" },
  labelStyle: { color: TEXT_MUTED, fontWeight: 500, marginBottom: 2 },
} as const;

// Credits, not rand. These charts plot ledger movements and court spend, both of
// which are credit-denominated — a rand sign here overstates every bar by the
// conversion rate.
const fmtCredits = (v: number | string) => formatCredits(Number(v));
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
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.4} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Area type="monotone" dataKey="top_ups_credits" name="Top-ups" stroke={ACCENT} fill="url(#revFill)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * The club's money by day. <b>Penalties are net</b> — see {@link signedFloor} — so the
 * series is labelled as such in the legend and the tooltip, and the bar goes below the
 * zero line on a day whose penalty rows are reversals of an earlier day's sweep.
 */
export function DailyFlowBarChart({ data }: { data: DailyAdminPoint[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} domain={SIGNED_DOMAIN} />
          <ReferenceLine y={0} stroke={ZERO_LINE_STROKE} strokeWidth={1} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={SUCCESS} radius={[3, 3, 0, 0]} />
          <Bar dataKey="booking_charges_credits" name="Bookings" stackId="b" fill={ACCENT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="penalties_credits" name="Penalties (net)" stackId="b" fill={WARNING} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BookingsLineChart({ data }: { data: DailyAdminPoint[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis allowDecimals={false} fontSize={11} stroke={TEXT_MUTED} width={32} />
          <Tooltip {...tooltipStyle} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line type="monotone" dataKey="bookings" name="Bookings" stroke={ACCENT} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="no_shows" name="No-shows" stroke={DANGER} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CourtsRevenueBarChart({ data }: { data: { court_name: string; revenue_credits: number; bookings: number }[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="court_name" fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} />
          <Bar dataKey="revenue_credits" name="Revenue" fill={ACCENT} radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function NoShowDonut({ total, noShow }: { total: number; noShow: number }) {
  const showed = Math.max(0, total - noShow);
  const data = [
    { name: "Showed up", value: showed, color: SUCCESS },
    { name: "No-shows", value: noShow, color: DANGER },
  ];
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={60} outerRadius={90} paddingAngle={2} stroke="none">
            {data.map((d) => <Cell key={d.name} fill={d.color} />)}
          </Pie>
          <Tooltip {...tooltipStyle} />
          <Legend verticalAlign="bottom" wrapperStyle={{ fontSize: 11 }} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MyBalanceLineChart({ data }: { data: DailyMePoint[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="balFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Area type="monotone" dataKey="balance_credits" name="Balance" stroke={ACCENT} fill="url(#balFill)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
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
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} domain={SIGNED_DOMAIN} />
          <ReferenceLine y={0} stroke={ZERO_LINE_STROKE} strokeWidth={1} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={SUCCESS} radius={[3, 3, 0, 0]} />
          <Bar dataKey="refunds_credits" name="Refunds (net)" stackId="a" fill={SUCCESS_SOFT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="spent_credits" name="Spent" stackId="b" fill={ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
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
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis allowDecimals={false} fontSize={11} stroke={TEXT_MUTED} width={32} />
          <Tooltip {...tooltipStyle} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="bookings" name="Booked" fill={ACCENT_SOFT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="attended" name="Played" fill={ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Re-export the soft palette so call-sites don't need to know recharts.
export const ChartColors = { ACCENT, ACCENT_SOFT, SUCCESS, WARNING, DANGER };
