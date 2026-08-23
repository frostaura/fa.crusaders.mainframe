import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, Line, LineChart,
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

export function DailyFlowBarChart({ data }: { data: DailyAdminPoint[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={SUCCESS} radius={[3, 3, 0, 0]} />
          <Bar dataKey="booking_charges_credits" name="Bookings" stackId="b" fill={ACCENT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="penalties_credits" name="Penalties" stackId="b" fill={WARNING} radius={[3, 3, 0, 0]} />
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

export function MyFlowBarChart({ data }: { data: DailyMePoint[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }} stackOffset="sign">
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis tickFormatter={fmtCredits} fontSize={11} stroke={TEXT_MUTED} width={48} />
          <Tooltip {...tooltipStyle} formatter={((v: number) => fmtCredits(v)) as never} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="top_ups_credits" name="Top-ups" stackId="a" fill={SUCCESS} radius={[3, 3, 0, 0]} />
          <Bar dataKey="refunds_credits" name="Refunds" stackId="a" fill={SUCCESS_SOFT} radius={[3, 3, 0, 0]} />
          <Bar dataKey="spent_credits" name="Spent" stackId="b" fill={ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MyBookingsBarChart({ data }: { data: DailyMePoint[] }) {
  return (
    <div style={{ height: CHART_HEIGHT }}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" vertical={false} />
          <XAxis dataKey="date" tickFormatter={fmtDate} fontSize={11} stroke={TEXT_MUTED} />
          <YAxis allowDecimals={false} fontSize={11} stroke={TEXT_MUTED} width={32} />
          <Tooltip {...tooltipStyle} labelFormatter={((l: string) => fmtDate(l)) as never} />
          <Bar dataKey="bookings" name="Bookings" fill={ACCENT} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Re-export the soft palette so call-sites don't need to know recharts.
export const ChartColors = { ACCENT, ACCENT_SOFT, SUCCESS, WARNING, DANGER };
