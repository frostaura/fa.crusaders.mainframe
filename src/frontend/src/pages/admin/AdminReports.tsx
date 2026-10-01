import {
  endpoints, type DailyAdminPoint, type RevenueReport, type UtilisationRow,
} from "../../lib/api";
import { formatCredits, formatMinutes, formatMoney, formatSignedCredits } from "../../lib/utils";
import { PageHeader, PageShell, Section } from "../../components/ui/page-shell";
import { Freshness, RefreshButton } from "../../components/ui/refresh-button";
import { StateBlock } from "../../components/ui/state-block";
import { Alert } from "../../components/Alert";
import { DataTable, type DataColumn } from "../../components/DataTable";
import {
  BookingsLineChart, CourtsRevenueBarChart, DailyFlowBarChart, NoShowDonut, RevenueAreaChart,
} from "../../components/Charts";
import type { CarouselSlide } from "../../components/Carousel";
import {
  Cell, ChartsCard, NetCredits, NetNote, RangeToolbar, ReportSkeleton, Stat, StatTiles, TableNotes, TotalsCard,
  type Tile,
} from "../../components/reports/ReportParts";
import { prettyDay, useReport, useReportRange } from "../../components/reports/range";
import { REPORT_SHARES_COPY } from "../../lib/playersCopy";

/**
 * `/admin/reports` — the club's money, courts and attendance for a period.
 *
 * <p>
 * The admin half of the old `/reports` (R16). It no longer reads the admin's OWN wallet report
 * at all: a desk account's balance is zero by design (`feature-spec.md` §8 — "it never plays"),
 * so the "My wallet — totals" panel it used to carry, and the wallet CSV beside it, described an
 * account that has nothing to describe, in the middle of the report whose subject is the club.
 * </p>
 */
type ClubReport = {
  revenue: RevenueReport;
  utilisation: UtilisationRow[];
  noShows: { total: number; no_show: number; no_show_pct: number };
  days: DailyAdminPoint[];
};

async function loadClub(markers: { from: string; to: string }): Promise<ClubReport> {
  const [revenue, utilisation, noShows, days] = await Promise.all([
    endpoints.reportRevenue(markers.from, markers.to),
    endpoints.reportUtilisation(markers.from, markers.to),
    endpoints.reportNoShows(markers.from, markers.to),
    endpoints.reportDailyAdmin(markers.from, markers.to),
  ]);
  return { revenue, utilisation: utilisation.by_court, noShows, days };
}

const REFRESH_FAILED = "Couldn't refresh these figures — they are from the last read. Try Refresh again.";

export default function AdminReportsPage() {
  const [range, setRange] = useReportRange();
  const report = useReport(range, loadClub);
  const { data } = report;

  return (
    <PageShell width="full">
      <PageHeader
        title="Reports"
        description="The club's money, courts and attendance, for any period."
        actions={<RefreshButton onRefresh={report.refresh} loading={report.loading && data !== null} />}
        freshness={<Freshness at={report.readAt} />}
      />
      <RangeToolbar range={range} onChange={setRange} />
      {report.error && data ? <Alert tone="warning">{REFRESH_FAILED}</Alert> : null}
      <StateBlock
        loading={report.loading && data === null}
        error={data === null ? report.error : null}
        action="load the club's reports"
        onRetry={report.refresh}
        skeleton={<ReportSkeleton />}
        className="gap-8"
      >
        {data ? <ClubBody data={data} /> : null}
      </StateBlock>
    </PageShell>
  );
}

function ClubBody({ data }: { data: ClubReport }) {
  const { revenue, noShows, days } = data;
  const tiles: Tile[] = [
    { label: "Net revenue", value: formatMoney(revenue.net_zar), tone: "accent" },
    { label: "Top-ups", value: formatCredits(revenue.gross_topups_credits), tone: "success" },
    // Courts played, summed from the day series — the same clock as the table's column below.
    { label: "Courts played", value: String(days.reduce((s, d) => s + d.bookings, 0)), tone: "neutral" },
    { label: "No-show rate", value: `${noShows.no_show_pct.toFixed(1)}%`, tone: noShows.no_show_pct > 5 ? "warning" : "neutral" },
  ];
  return (
    <>
      <StatTiles tiles={tiles} label="This period at a glance" />
      <ClubTotals days={days} />
      <Section title="Charts">
        <ChartsCard slides={clubSlides(data)} />
      </Section>
      <Utilisation rows={data.utilisation} />
      <DailyBreakdown days={days} />
    </>
  );
}

function clubSlides({ days, utilisation, noShows }: ClubReport): CarouselSlide[] {
  const slides: CarouselSlide[] = [
    { key: "rev", title: "Top-ups over time", node: <RevenueAreaChart data={days} /> },
    { key: "flow", title: "Daily money flow", node: <DailyFlowBarChart data={days} /> },
    { key: "bk", title: "Bookings & no-shows", node: <BookingsLineChart data={days} /> },
  ];
  if (utilisation.length > 0) slides.push({ key: "courts", title: "Revenue by court", node: <CourtsRevenueBarChart data={utilisation} /> });
  if (noShows.total > 0) slides.push({ key: "ns", title: "Show rate", node: <NoShowDonut total={noShows.total} noShow={noShows.no_show} /> });
  return slides;
}

/**
 * The club's period totals, summed over the server's daily buckets — `reporting.md` forbids
 * client-side aggregation over raw rows, and a bounded day series is the pre-aggregation it asks
 * for.
 *
 * <p>
 * The net is summed from the server's own type-blind daily total, not re-derived from the named
 * buckets: this card once added five buckets that between them did not include
 * `PaymentReversal`, and printed +555.00 over a true movement of +395.00 while claiming to be
 * "every ledger movement in the club summed".
 * </p>
 */
function sumDays(days: DailyAdminPoint[]) {
  const sum = (pick: (d: DailyAdminPoint) => number) => days.reduce((s, d) => s + pick(d), 0);
  return {
    topUps: sum((d) => d.top_ups_credits),
    charges: sum((d) => d.booking_charges_credits),
    refunds: sum((d) => d.refunds_credits),
    penalties: sum((d) => d.penalties_credits),
    adjustments: sum((d) => d.adjustments_credits),
    reversals: sum((d) => d.reversals_credits),
    shares: sum((d) => d.share_transfers_credits ?? 0),
    bookings: sum((d) => d.bookings),
    noShows: sum((d) => d.no_shows),
    net: sum((d) => d.net_movement_credits),
  };
}

/**
 * The club's own money, including the figure that was once on no screen at all: what the desk
 * added or took back by hand (Adjustments), and a payment clawed back after the fact (Reversals).
 */
/** D11 — whether the server sent the share bucket at all. An older API does not, and then no row. */
function carriesShares(days: DailyAdminPoint[]): boolean {
  return days.some((d) => typeof d.share_transfers_credits === "number");
}

function ClubTotals({ days }: { days: DailyAdminPoint[] }) {
  const t = sumDays(days);
  const shares = carriesShares(days);
  return (
    <Section title="Club money — totals" description="Every movement of member credit across the club in this period.">
      <TotalsCard
        // Nine or ten figures: whole rows either way (VIS F3-15 — ten in four columns orphaned two).
        columns={shares ? 5 : 3}
        footnote={(
          <>
            Credit held by members moved by <strong className="font-semibold tabular-nums text-text-primary">{formatSignedCredits(t.net)}</strong> over
            this period — top-ups − charges + refunds − penalties + adjustments + reversals, which is every ledger movement
            in the club summed. <strong className="font-semibold text-text-primary">Adjustments</strong> is what the desk added or took back by hand;{" "}
            <strong className="font-semibold text-text-primary">Reversals</strong> is a payment clawed back after the fact.
            {shares ? <> <strong className="font-semibold text-text-primary">{REPORT_SHARES_COPY.clubShares}</strong>: {REPORT_SHARES_COPY.clubCaption}</> : null}
          </>
        )}
      >
        <Stat label="Top-ups" value={formatSignedCredits(t.topUps)} />
        <Stat label="Charges" value={formatSignedCredits(-t.charges)} />
        <Stat label="Refunds (net)" value={formatSignedCredits(t.refunds)} />
        <Stat label="Penalties (net)" value={formatSignedCredits(-t.penalties)} />
        <Stat label="Adjustments" value={formatSignedCredits(t.adjustments)} />
        <Stat label="Reversals" value={formatSignedCredits(t.reversals)} />
        {shares ? <Stat label={REPORT_SHARES_COPY.clubShares} value={formatSignedCredits(t.shares)} /> : null}
        <Stat label="Courts played" value={String(t.bookings)} />
        <Stat label="No-shows" value={String(t.noShows)} />
        <Stat label="Days" value={String(days.length)} />
      </TotalsCard>
    </Section>
  );
}

const COURT_COLUMNS: DataColumn<UtilisationRow>[] = [
  { key: "court_name", header: "Court", cell: (r) => <Cell>{r.court_name}</Cell> },
  { key: "bookings", header: "Bookings", align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
  // Minutes, not slices. A 60-minute walk-up is SliceCount 1 and was counted the same as a
  // 15-minute booking, so the column mixed units.
  { key: "booked_minutes", header: "Booked", align: "right", cell: (r) => <Cell>{formatMinutes(r.booked_minutes)}</Cell>, sortValue: (r) => r.booked_minutes },
  { key: "quoted_credits", header: "Quoted", align: "right", cell: (r) => <Cell>{formatCredits(r.quoted_credits)}</Cell>, sortValue: (r) => r.quoted_credits },
  { key: "revenue_credits", header: "Kept", align: "right", cell: (r) => <Cell>{formatCredits(r.revenue_credits)}</Cell>, sortValue: (r) => r.revenue_credits },
];

function Utilisation({ rows }: { rows: UtilisationRow[] }) {
  return (
    <Section title="Utilisation by court" description={`${rows.length} court${rows.length === 1 ? "" : "s"}`}>
      <DataTable
        label="Utilisation, one row per court"
        rows={rows}
        rowKey={(r) => r.court_id}
        search={{ placeholder: "Filter by court name…", fields: (r) => r.court_name }}
        defaultSort={{ key: "revenue_credits", dir: "desc" }}
        emptyTitle="No bookings in this window."
        columns={COURT_COLUMNS}
      />
      <TableNotes>
        <p className="text-sm text-text-secondary">
          <strong className="font-semibold text-text-primary">Quoted</strong> is the price at booking.{" "}
          <strong className="font-semibold text-text-primary">Kept</strong> is what the club actually took once refunds,
          penalties and any desk adjustments naming the booking are netted — for a no-show that is the penalty, not the price.
        </p>
      </TableNotes>
    </Section>
  );
}

const DAY_COLUMNS: DataColumn<DailyAdminPoint>[] = [
  { key: "date", header: "Date", cell: (r) => <Cell>{prettyDay(r.date)}</Cell>, sortValue: (r) => r.date, width: 130 },
  { key: "top_ups_credits", header: "Top-ups", align: "right", cell: (r) => <Cell>{formatCredits(r.top_ups_credits)}</Cell>, sortValue: (r) => r.top_ups_credits },
  { key: "booking_charges_credits", header: "Charges", align: "right", cell: (r) => <Cell>{formatCredits(r.booking_charges_credits)}</Cell>, sortValue: (r) => r.booking_charges_credits },
  { key: "refunds_credits", header: "Refunds (net)", align: "right", cell: (r) => <NetCredits value={r.refunds_credits} />, sortValue: (r) => r.refunds_credits },
  { key: "penalties_credits", header: "Penalties (net)", align: "right", cell: (r) => <NetCredits value={r.penalties_credits} />, sortValue: (r) => r.penalties_credits },
  { key: "adjustments_credits", header: "Adjustments", align: "right", cell: (r) => <NetCredits value={r.adjustments_credits} />, sortValue: (r) => r.adjustments_credits },
  // Reversals were on no screen at all while the totals card claimed to sum every movement.
  { key: "reversals_credits", header: "Reversals", align: "right", cell: (r) => <NetCredits value={r.reversals_credits} />, sortValue: (r) => r.reversals_credits },
  // "Courts played", not "Bookings": these two count the day the court is USED; every money
  // column to their left counts the day the money MOVED. Under a 14-day advance window those
  // are routinely different days ("Charges 2300.00 cr · Bookings 6").
  { key: "bookings", header: "Courts played", align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
  { key: "no_shows", header: "No-shows", align: "right", cell: (r) => <Cell>{r.no_shows}</Cell>, sortValue: (r) => r.no_shows },
];

/** The share column, after Reversals — only when the server sends the bucket. */
const SHARES_COLUMN: DataColumn<DailyAdminPoint> = {
  key: "share_transfers_credits",
  header: REPORT_SHARES_COPY.clubShares,
  align: "right",
  cell: (r) => <NetCredits value={r.share_transfers_credits ?? 0} />,
  sortValue: (r) => r.share_transfers_credits ?? 0,
};

function dayColumns(shares: boolean): DataColumn<DailyAdminPoint>[] {
  if (!shares) return DAY_COLUMNS;
  const at = DAY_COLUMNS.findIndex((c) => c.key === "reversals_credits") + 1;
  return [...DAY_COLUMNS.slice(0, at), SHARES_COLUMN, ...DAY_COLUMNS.slice(at)];
}

function DailyBreakdown({ days }: { days: DailyAdminPoint[] }) {
  const shares = carriesShares(days);
  return (
    <Section title="Daily breakdown" description={`${days.length} day${days.length === 1 ? "" : "s"}`}>
      <DataTable
        label="Daily breakdown, one row per day"
        rows={days}
        rowKey={(r) => r.date}
        defaultSort={{ key: "date", dir: "desc" }}
        emptyTitle="No activity in this window."
        maxHeight="60vh"
        columns={dayColumns(shares)}
      />
      <TableNotes>
        <p className="text-sm text-text-secondary">
          <strong className="font-semibold text-text-primary">Two dates in one row, on purpose.</strong> The money columns count the day the money moved;
          <strong className="font-semibold text-text-primary"> Courts played</strong> and <strong className="font-semibold text-text-primary">No-shows</strong> count
          the day the court is booked for. A member who books a fortnight ahead is charged today and plays later, so the two
          halves of a row are not about the same bookings. Days are the club&#39;s own, in its configured timezone.
        </p>
        <NetNote what="Refunds, penalties, adjustments and reversals" />
        {shares ? <p className="text-sm text-text-secondary">{REPORT_SHARES_COPY.clubCaption}</p> : null}
      </TableNotes>
    </Section>
  );
}
