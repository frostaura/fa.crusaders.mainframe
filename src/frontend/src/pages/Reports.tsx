import { useEffect, useState } from "react";
import { endpoints, type WalletReport, type RevenueReport, type DailyAdminPoint, type DailyMePoint } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { Carousel, type CarouselSlide } from "../components/Carousel";
import { DataTable, type DataColumn } from "../components/DataTable";
import {
  RevenueAreaChart, DailyFlowBarChart, BookingsLineChart, CourtsRevenueBarChart,
  NoShowDonut, MyBalanceLineChart, MyFlowBarChart, MyBookingsBarChart,
} from "../components/Charts";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

type UtilRow = { court_id: string; court_number: number; court_name: string; slices: number; bookings: number; revenue_zar: number };

export default function ReportsPage() {
  const auth = useAuth();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(() => ymd(new Date()));

  const [wallet, setWallet] = useState<WalletReport | null>(null);
  const [revenue, setRevenue] = useState<RevenueReport | null>(null);
  const [util, setUtil] = useState<{ from: string; to: string; by_court: UtilRow[] } | null>(null);
  const [noShow, setNoShow] = useState<{ total: number; no_show: number; no_show_pct: number } | null>(null);
  const [dailyAdmin, setDailyAdmin] = useState<DailyAdminPoint[] | null>(null);
  const [dailyMe, setDailyMe] = useState<DailyMePoint[] | null>(null);

  const load = async () => {
    const fIso = `${from}T00:00:00Z`;
    const tIso = `${to}T23:59:59Z`;
    const [w, dm] = await Promise.all([endpoints.reportWallet(fIso, tIso), endpoints.reportDailyMe(fIso, tIso)]);
    setWallet(w); setDailyMe(dm);
    if (isAdmin) {
      const [r, u, ns, da] = await Promise.all([
        endpoints.reportRevenue(fIso, tIso),
        endpoints.reportUtilisation(fIso, tIso),
        endpoints.reportNoShows(fIso, tIso),
        endpoints.reportDailyAdmin(fIso, tIso),
      ]);
      setRevenue(r); setUtil(u); setNoShow(ns); setDailyAdmin(da);
    }
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to, isAdmin]);

  const tiles = isAdmin
    ? [
        { label: "Net revenue", value: revenue ? `R${revenue.net_zar.toFixed(0)}` : "—", tone: "accent" as const },
        { label: "Top-ups", value: revenue ? `R${revenue.gross_topups_zar.toFixed(0)}` : "—", tone: "success" as const },
        { label: "Bookings", value: dailyAdmin ? String(dailyAdmin.reduce((s, d) => s + d.bookings, 0)) : "—", tone: "neutral" as const },
        { label: "No-show rate", value: noShow ? `${noShow.no_show_pct.toFixed(1)}%` : "—", tone: noShow && noShow.no_show_pct > 5 ? "warning" as const : "neutral" as const },
      ]
    : [
        { label: "Top-ups", value: wallet ? `R${wallet.top_ups_zar.toFixed(0)}` : "—", tone: "success" as const },
        { label: "Spent", value: wallet ? `R${wallet.spent_zar.toFixed(0)}` : "—", tone: "accent" as const },
        { label: "Refunds", value: wallet ? `R${wallet.refunds_zar.toFixed(0)}` : "—", tone: "neutral" as const },
        { label: "Movements", value: wallet ? String(wallet.count) : "—", tone: "neutral" as const },
      ];

  const slides: CarouselSlide[] = [];
  if (isAdmin && dailyAdmin) {
    slides.push({ key: "rev", title: "Top-ups over time", node: <RevenueAreaChart data={dailyAdmin} /> });
    slides.push({ key: "flow", title: "Daily money flow", node: <DailyFlowBarChart data={dailyAdmin} /> });
    slides.push({ key: "bk", title: "Bookings & no-shows", node: <BookingsLineChart data={dailyAdmin} /> });
    if (util && util.by_court.length > 0) {
      slides.push({ key: "courts", title: "Revenue by court", node: <CourtsRevenueBarChart data={util.by_court} /> });
    }
    if (noShow && noShow.total > 0) {
      slides.push({ key: "ns", title: "Show rate", node: <NoShowDonut total={noShow.total} noShow={noShow.no_show} /> });
    }
  } else if (dailyMe) {
    slides.push({ key: "balance", title: "Wallet balance", node: <MyBalanceLineChart data={dailyMe} /> });
    slides.push({ key: "flow", title: "Daily money flow", node: <MyFlowBarChart data={dailyMe} /> });
    slides.push({ key: "bk", title: "My bookings", node: <MyBookingsBarChart data={dailyMe} /> });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <p className="text-xs text-text-muted mb-1">From</p>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-11 px-3 rounded-lg border border-border bg-bg-surface" />
        </div>
        <div>
          <p className="text-xs text-text-muted mb-1">To</p>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-11 px-3 rounded-lg border border-border bg-bg-surface" />
        </div>
        {/* Phase 8.7 — monthly presets per client blueprint C.4 */}
        <div className="flex gap-1">
          <Button variant="outline" type="button" onClick={() => {
            const now = new Date();
            setFrom(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
            setTo(ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)));
          }}>This month</Button>
          <Button variant="outline" type="button" onClick={() => {
            const now = new Date();
            setFrom(ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
            setTo(ymd(new Date(now.getFullYear(), now.getMonth(), 0)));
          }}>Last month</Button>
          <Button variant="outline" type="button" onClick={() => {
            const now = new Date();
            setFrom(ymd(new Date(Date.now() - 30 * 86400000)));
            setTo(ymd(now));
          }}>Last 30 days</Button>
        </div>
        <a href={endpoints.walletCsvUrl(`${from}T00:00:00Z`, `${to}T23:59:59Z`)} download className="ml-auto">
          <Button variant="outline">Download wallet CSV</Button>
        </a>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((t) => <Tile key={t.label} {...t} />)}
      </div>

      {/* Personal wallet summary — sits right under the tiles for at-a-glance context. */}
      {wallet && (
        <Card>
          <h2 className="font-semibold mb-3">My wallet — totals</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
            <Stat label="Top-ups" value={`R${wallet.top_ups_zar.toFixed(2)}`} />
            <Stat label="Spent" value={`R${wallet.spent_zar.toFixed(2)}`} />
            <Stat label="Refunds" value={`R${wallet.refunds_zar.toFixed(2)}`} />
            <Stat label="Penalty count" value={String(wallet.penalty_count)} />
            <Stat label="Movements" value={String(wallet.count)} />
          </dl>
        </Card>
      )}

      {/* Charts carousel */}
      {slides.length > 0 && (
        <Card className="!p-3 sm:!p-4">
          <Carousel slides={slides} />
        </Card>
      )}

      {/* Tables */}
      {isAdmin && util && (
        <Card>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold">Utilisation by court</h2>
            <span className="text-xs text-text-muted">{util.by_court.length} court{util.by_court.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={util.by_court}
            rowKey={(r) => r.court_id}
            search={{ placeholder: "Filter by court name…", fields: (r) => r.court_name }}
            defaultSort={{ key: "revenue_zar", dir: "desc" }}
            emptyTitle="No bookings in this window."
            columns={[
              { key: "court_name", header: "Court", cell: (r) => r.court_name },
              { key: "bookings", header: "Bookings", align: "right", cell: (r) => r.bookings, sortValue: (r) => r.bookings },
              { key: "slices", header: "Slices", align: "right", cell: (r) => r.slices, sortValue: (r) => r.slices },
              { key: "revenue_zar", header: "Revenue", align: "right", cell: (r) => `R${r.revenue_zar.toFixed(2)}`, sortValue: (r) => r.revenue_zar },
            ] satisfies DataColumn<UtilRow>[]}
          />
        </Card>
      )}

      {isAdmin && dailyAdmin && (
        <Card>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold">Daily breakdown</h2>
            <span className="text-xs text-text-muted">{dailyAdmin.length} day{dailyAdmin.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={dailyAdmin}
            rowKey={(r) => r.date}
            defaultSort={{ key: "date", dir: "desc" }}
            emptyTitle="No activity in this window."
            maxHeight="60vh"
            columns={[
              { key: "date", header: "Date", cell: (r) => prettyDate(r.date), sortValue: (r) => r.date, width: 130 },
              { key: "top_ups_zar", header: "Top-ups", align: "right", cell: (r) => zar(r.top_ups_zar), sortValue: (r) => r.top_ups_zar },
              { key: "booking_charges_zar", header: "Charges", align: "right", cell: (r) => zar(r.booking_charges_zar), sortValue: (r) => r.booking_charges_zar },
              { key: "refunds_zar", header: "Refunds", align: "right", cell: (r) => zar(r.refunds_zar), sortValue: (r) => r.refunds_zar },
              { key: "penalties_zar", header: "Penalties", align: "right", cell: (r) => zar(r.penalties_zar), sortValue: (r) => r.penalties_zar },
              { key: "bookings", header: "Bookings", align: "right", cell: (r) => r.bookings, sortValue: (r) => r.bookings },
              { key: "no_shows", header: "No-shows", align: "right", cell: (r) => r.no_shows, sortValue: (r) => r.no_shows },
            ] satisfies DataColumn<DailyAdminPoint>[]}
          />
        </Card>
      )}

      {!isAdmin && dailyMe && (
        <Card>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-semibold">Daily breakdown</h2>
            <span className="text-xs text-text-muted">{dailyMe.length} day{dailyMe.length === 1 ? "" : "s"}</span>
          </div>
          <DataTable
            rows={dailyMe}
            rowKey={(r) => r.date}
            defaultSort={{ key: "date", dir: "desc" }}
            emptyTitle="No activity in this window."
            maxHeight="60vh"
            columns={[
              { key: "date", header: "Date", cell: (r) => prettyDate(r.date), sortValue: (r) => r.date, width: 130 },
              { key: "top_ups_zar", header: "Top-ups", align: "right", cell: (r) => zar(r.top_ups_zar), sortValue: (r) => r.top_ups_zar },
              { key: "spent_zar", header: "Spent", align: "right", cell: (r) => zar(r.spent_zar), sortValue: (r) => r.spent_zar },
              { key: "refunds_zar", header: "Refunds", align: "right", cell: (r) => zar(r.refunds_zar), sortValue: (r) => r.refunds_zar },
              { key: "bookings", header: "Bookings", align: "right", cell: (r) => r.bookings, sortValue: (r) => r.bookings },
              { key: "balance_zar", header: "Balance", align: "right", cell: (r) => zar(r.balance_zar), sortValue: (r) => r.balance_zar },
            ] satisfies DataColumn<DailyMePoint>[]}
          />
        </Card>
      )}

    </div>
  );
}

const zar = (v: number) => `R${v.toFixed(2)}`;
const prettyDate = (s: string) => new Date(s + "T00:00:00Z").toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

function Tile({ label, value, tone }: { label: string; value: string; tone: "accent" | "success" | "warning" | "neutral" }) {
  const tones: Record<string, string> = {
    accent: "bg-accent-soft text-accent-strong",
    success: "bg-success-soft text-success-strong",
    warning: "bg-warning-soft text-warning-strong",
    neutral: "bg-bg-muted text-text-primary",
  };
  return (
    <div className={`rounded-xl p-3 sm:p-4 ${tones[tone]}`}>
      <p className="text-[11px] uppercase tracking-wide opacity-70">{label}</p>
      <p className="font-semibold text-xl tabular-nums mt-1">{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-bg-muted/40 px-3 py-2.5">
      <dt className="text-[11px] uppercase tracking-wide text-text-muted">{label}</dt>
      <dd className="font-mono text-base text-text-primary mt-0.5">{value}</dd>
    </div>
  );
}
