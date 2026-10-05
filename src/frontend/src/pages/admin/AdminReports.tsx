import {
  endpoints, type DailyAdminPoint, type RevenueReport, type UtilisationRow,
} from "../../lib/api";
import { formatMinutes, formatMoney } from "../../lib/utils";
import { AutoGrid } from "../../components/ui/auto-grid";
import { Minutes } from "../../components/Minutes";
import { CLUB_REPORT_COPY as COPY, randPerHour } from "../../lib/reportsCopy";
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
  Cell, ChartsCard, MinutesGroups, NetMinutes, NetNote, RangeToolbar, ReportSkeleton, Stat, StatTiles, TableNotes, TotalsCard,
  type Tile,
} from "../../components/reports/ReportParts";
import { prettyDay, useReport, useReportRange } from "../../components/reports/range";
import { REPORT_SHARES_COPY } from "../../lib/playersCopy";
import { givenMinutes } from "../../components/wallet/walletBuckets";

/**
 * `/admin/reports` — the club's money, minutes, courts and attendance for a period.
 *
 * <p>
 * P13: the club sells minutes in packages, so the page reports both units and never mixes
 * them — rand received (what members paid), minutes sold (what that bought), and the price per
 * hour that joins the two (`zar_per_minute_sold`, contract §3.15); then every movement of
 * members' minutes, and each court's utilisation in minutes. On a desktop it uses the width:
 * sales beside the minutes totals, the charts beside the courts.
 * </p>
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

export default function AdminReportsPage() {
  const [range, setRange] = useReportRange();
  const report = useReport(range, loadClub);
  const { data } = report;

  return (
    <PageShell width="full">
      <PageHeader
        title={COPY.title}
        description={COPY.description}
        actions={<RefreshButton onRefresh={report.refresh} loading={report.loading && data !== null} />}
        freshness={<Freshness at={report.readAt} />}
      />
      <RangeToolbar range={range} onChange={setRange} />
      {report.error && data ? <Alert tone="warning">{COPY.refreshFailed}</Alert> : null}
      <StateBlock
        loading={report.loading && data === null}
        error={data === null ? report.error : null}
        action={COPY.action}
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
    { label: COPY.tiles.received, value: formatMoney(revenue.net_zar), tone: "accent" },
    { label: COPY.tiles.sold, value: <MinutesGroups value={revenue.net_minutes} />, tone: "success" },
    { label: COPY.tiles.perHour, value: randPerHour(revenue.zar_per_minute_sold), tone: "neutral" },
    { label: COPY.tiles.noShows, value: `${noShows.no_show_pct.toFixed(1)}%`, tone: noShows.no_show_pct > 5 ? "warning" : "neutral" },
  ];
  return (
    <>
      <StatTiles tiles={tiles} label={COPY.tilesLabel} />
      {/* Two panels a row where the box has the room (R4 form factor): a desktop reads sales
          beside the minutes they became, and the charts beside the courts. */}
      <AutoGrid min="panel" max={2} gap="xl" className="items-start" data-report-row="money">
        <Sales revenue={revenue} />
        <ClubTotals days={days} />
      </AutoGrid>
      <AutoGrid min="wide" max={2} gap="xl" className="items-start" data-report-row="courts">
        <Section title={COPY.charts.title}>
          <ChartsCard slides={clubSlides(data)} />
        </Section>
        <Utilisation rows={data.utilisation} />
      </AutoGrid>
      <DailyBreakdown days={days} />
    </>
  );
}

function clubSlides({ days, utilisation, noShows }: ClubReport): CarouselSlide[] {
  const slides: CarouselSlide[] = [
    { key: "rev", title: COPY.charts.sold, node: <RevenueAreaChart data={days} /> },
    { key: "flow", title: COPY.charts.flow, node: <DailyFlowBarChart data={days} /> },
    { key: "bk", title: COPY.charts.bookings, node: <BookingsLineChart data={days} /> },
  ];
  if (utilisation.length > 0) slides.push({ key: "courts", title: COPY.charts.courts, node: <CourtsRevenueBarChart data={utilisation} /> });
  if (noShows.total > 0) slides.push({ key: "ns", title: COPY.charts.shows, node: <NoShowDonut total={noShows.total} noShow={noShows.no_show} /> });
  return slides;
}

/**
 * What members paid, in rand, beside the minutes it bought them (contract §3.15). Rand is
 * from the purchase rows' `ZarPaid`, never derived from minutes — the two are joined only by
 * the price per hour, which the server computes from the nets.
 */
function Sales({ revenue }: { revenue: RevenueReport }) {
  return (
    <Section title={COPY.sales.title} description={COPY.sales.description}>
      <TotalsCard columns={4} footnote={<SalesFootnote given={revenue.given_minutes} />}>
        <Stat label={COPY.sales.receivedGross} value={formatMoney(revenue.gross_topups_zar)} />
        <Stat label={COPY.sales.receivedReversed} value={formatMoney(-revenue.reversals_zar)} />
        <Stat label={COPY.sales.receivedNet} value={formatMoney(revenue.net_zar)} />
        <Stat label={COPY.sales.soldGross} value={<MinutesGroups value={revenue.gross_topups_minutes} />} />
        <Stat label={COPY.sales.soldReversed} value={<MinutesGroups value={-revenue.reversals_minutes} />} />
        <Stat label={COPY.sales.soldNet} value={<MinutesGroups value={revenue.net_minutes} />} />
        <Stat label={COPY.sales.perHour} value={randPerHour(revenue.zar_per_minute_sold)} />
        <Stat label={COPY.sales.perMinute} value={randPerMinuteToCent(revenue.zar_per_minute_sold)} />
      </TotalsCard>
    </Section>
  );
}

/** The sales footnote, and the minutes the club gave apart from it when there were any (R13 J13-2). */
function SalesFootnote({ given }: { given: number | undefined }) {
  if (!given || given <= 0) return <>{COPY.sales.footnote}</>;
  return <>{COPY.sales.footnote} <span>{COPY.sales.givenNote(formatMinutes(given))}</span></>;
}

/**
 * The club's period totals, summed over the server's daily buckets — `reporting.md` forbids
 * client-side aggregation over raw rows, and a bounded day series is the pre-aggregation it asks
 * for.
 *
 * <p>
 * The net is summed from the server's own type-blind daily total, not re-derived from the named
 * buckets: this card once added five buckets that between them did not include
 * `PaymentReversal`, and printed +555 over a true movement of +395 while claiming to be
 * "every ledger movement in the club summed".
 * </p>
 */
function sumDays(days: DailyAdminPoint[]) {
  const sum = (pick: (d: DailyAdminPoint) => number) => days.reduce((s, d) => s + pick(d), 0);
  const given = sum(givenMinutes);
  return {
    // R14 J14-2: "Sold" is paid minutes only — top-ups less what the club gave (a subset the daily
    // report carries; 0 from an older server), so it agrees with the Sales card's minutes sold.
    sold: sum((d) => d.top_ups_minutes) - given,
    given,
    charges: sum((d) => d.booking_charges_minutes),
    refunds: sum((d) => d.refunds_minutes),
    penalties: sum((d) => d.penalties_minutes),
    adjustments: sum((d) => d.adjustments_minutes),
    reversals: sum((d) => d.reversals_minutes),
    shares: sum((d) => d.share_transfers_minutes ?? 0),
    bookings: sum((d) => d.bookings),
    noShows: sum((d) => d.no_shows),
    net: sum((d) => d.net_movement_minutes),
  };
}

/** D11 — whether the server sent the share bucket at all. An older API does not, and then no row. */
function carriesShares(days: DailyAdminPoint[]): boolean {
  return days.some((d) => typeof d.share_transfers_minutes === "number");
}

/** R14 J14-2 — a day's sold minutes: its top-ups less what the club gave that day. */
const soldOn = (d: DailyAdminPoint) => d.top_ups_minutes - givenMinutes(d);

/** Whole rows for `n` totals: five, four or three across, whichever leaves no orphan (else the fullest last row). */
function wholeRows(n: number): 3 | 4 | 5 {
  const fits = ([5, 4, 3] as const).find((c) => n % c === 0);
  return fits ?? ([5, 4, 3] as const).reduce((best, c) => (n % c > n % best ? c : best));
}

/** A signed minutes figure for a totals card: "+2 h", "−45 min", a zero with no sign. */
const signed = (value: number) => <Minutes value={value} signed />;

/**
 * Rand per minute sold, to the cent and rounded down like every figure under it (R6 L6-14): the
 * server keeps four places for the per-HOUR sum, but "R1.8611" printed four places of rand.
 */
function randPerMinuteToCent(zarPerMinute: number | null | undefined): string {
  if (typeof zarPerMinute !== "number" || !Number.isFinite(zarPerMinute)) return COPY.noRate;
  return formatMoney(Math.floor(zarPerMinute * 100 + 1e-9) / 100);
}

/**
 * The club's own minutes, including the figure that was once on no screen at all: what the desk
 * added or took back by hand (Adjustments), and a payment clawed back after the fact (Reversals).
 */
function ClubTotals({ days }: { days: DailyAdminPoint[] }) {
  const t = sumDays(days);
  const shares = carriesShares(days);
  const given = t.given > 0;
  const strong = "font-semibold text-text-primary";
  return (
    <Section title={COPY.totals.title} description={COPY.totals.description}>
      <TotalsCard
        // Nine to eleven figures: whole rows where they divide (VIS F3-15 — ten in four columns orphaned two).
        columns={wholeRows(9 + (shares ? 1 : 0) + (given ? 1 : 0))}
        footnote={(
          <>
            {COPY.totals.netLead} <strong className={`${strong} tabular-nums`}>{signed(t.net)}</strong> {COPY.totals.netTail(given)}{" "}
            {given ? <><strong className={strong}>{COPY.totals.given}</strong> {COPY.totals.givenNote}{" "}</> : null}
            <strong className={strong}>{COPY.totals.adjustments}</strong> {COPY.totals.adjustmentsNote}{" "}
            <strong className={strong}>{COPY.totals.reversals}</strong> {COPY.totals.reversalsNote}
            {shares ? <> <strong className={strong}>{REPORT_SHARES_COPY.clubShares}</strong>: {REPORT_SHARES_COPY.clubCaption}</> : null}
          </>
        )}
      >
        {/* Each bucket as the daily table below shows it (R6 L6-14): the sentence under the card
            ("sold − bookings + refunds − penalties …") applies the signs. Bookings was "−24 min" in
            danger red above a table saying "24 min" — subtracted twice by anyone who read both. */}
        <Stat label={COPY.totals.sold} value={<MinutesGroups value={t.sold} />} />
        {given ? <Stat label={COPY.totals.given} value={<MinutesGroups value={t.given} />} /> : null}
        <Stat label={COPY.totals.charges} value={<MinutesGroups value={t.charges} />} />
        <Stat label={COPY.totals.refunds} value={<NetMinutes wrap value={t.refunds} />} />
        <Stat label={COPY.totals.penalties} value={<NetMinutes wrap value={t.penalties} />} />
        <Stat label={COPY.totals.adjustments} value={<NetMinutes wrap value={t.adjustments} />} />
        <Stat label={COPY.totals.reversals} value={<NetMinutes wrap value={t.reversals} />} />
        {shares ? <Stat label={REPORT_SHARES_COPY.clubShares} value={<NetMinutes wrap value={t.shares} />} /> : null}
        <Stat label={COPY.totals.courtsPlayed} value={String(t.bookings)} />
        <Stat label={COPY.totals.noShows} value={String(t.noShows)} />
        <Stat label={COPY.totals.days} value={String(days.length)} />
      </TotalsCard>
    </Section>
  );
}

const U = COPY.utilisation;

const COURT_COLUMNS: DataColumn<UtilisationRow>[] = [
  { key: "court_name", header: U.court, cell: (r) => <Cell>{r.court_name}</Cell> },
  { key: "bookings", header: U.bookings, align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
  // How long, not slices. A 60-minute walk-up is SliceCount 1 and was counted the same as a
  // 15-minute booking, so the column mixed units. A duration — drawn through `<Minutes>` (R7 X7-6)
  // so a screen reader hears "3 hours", not "3 h", like every other figure in this table.
  { key: "booked_minutes", header: U.booked, align: "right", cell: (r) => <Cell><Minutes value={r.booked_minutes} /></Cell>, sortValue: (r) => r.booked_minutes },
  // P13 §3.15: `sold_minutes` is Σ AmountChargedMinutes — what the bookings were charged. The
  // header said "Quoted", which was the price-list word; there is no price list any more.
  { key: "sold_minutes", header: U.charged, align: "right", cell: (r) => <Cell><Minutes value={r.sold_minutes} /></Cell>, sortValue: (r) => r.sold_minutes },
  { key: "kept_minutes", header: U.kept, align: "right", cell: (r) => <Cell><Minutes value={r.kept_minutes} /></Cell>, sortValue: (r) => r.kept_minutes },
];

function Utilisation({ rows }: { rows: UtilisationRow[] }) {
  const strong = "font-semibold text-text-primary";
  return (
    <Section title={U.title} description={COPY.courts(rows.length)}>
      <DataTable
        label={U.label}
        rows={rows}
        rowKey={(r) => r.court_id}
        search={{ placeholder: U.filter, fields: (r) => r.court_name }}
        defaultSort={{ key: "kept_minutes", dir: "desc" }}
        emptyTitle={U.empty}
        // R8 (L6-14 / L7-17): the same header shape as the daily table below, so a sort caret sits
        // UNDER its label in every table on the page, never beside here and under there.
        wrapHeaders
        columns={COURT_COLUMNS}
      />
      <TableNotes>
        <p className="text-sm text-text-secondary">
          <strong className={strong}>{U.charged}</strong> {U.note.charged}{" "}
          <strong className={strong}>{U.kept}</strong> {U.note.kept}
        </p>
      </TableNotes>
    </Section>
  );
}

const D = COPY.daily;

const DAY_COLUMNS: DataColumn<DailyAdminPoint>[] = [
  { key: "date", header: D.date, cell: (r) => <Cell>{prettyDay(r.date)}</Cell>, sortValue: (r) => r.date, width: 130 },
  // R14 J14-2: paid minutes only; what the club gave is the Given column beside it, when there was any.
  { key: "top_ups_minutes", header: D.sold, align: "right", cell: (r) => <Cell><Minutes value={soldOn(r)} /></Cell>, sortValue: soldOn },
  { key: "booking_charges_minutes", header: D.charges, align: "right", cell: (r) => <Cell><Minutes value={r.booking_charges_minutes} /></Cell>, sortValue: (r) => r.booking_charges_minutes },
  { key: "refunds_minutes", header: D.refunds, align: "right", cell: (r) => <NetMinutes value={r.refunds_minutes} />, sortValue: (r) => r.refunds_minutes },
  { key: "penalties_minutes", header: D.penalties, align: "right", cell: (r) => <NetMinutes value={r.penalties_minutes} />, sortValue: (r) => r.penalties_minutes },
  { key: "adjustments_minutes", header: D.adjustments, align: "right", cell: (r) => <NetMinutes value={r.adjustments_minutes} />, sortValue: (r) => r.adjustments_minutes },
  // Reversals were on no screen at all while the totals card claimed to sum every movement.
  { key: "reversals_minutes", header: D.reversals, align: "right", cell: (r) => <NetMinutes value={r.reversals_minutes} />, sortValue: (r) => r.reversals_minutes },
  // "Courts played", not "Bookings": these two count the day the court is USED; every minutes
  // column to their left counts the day the minutes MOVED. Under a 14-day advance window those
  // are routinely different days ("Bookings 38 h · Courts played 6").
  { key: "bookings", header: D.courtsPlayed, align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
  { key: "no_shows", header: D.noShows, align: "right", cell: (r) => <Cell>{r.no_shows}</Cell>, sortValue: (r) => r.no_shows },
];

/** The share column, after Reversals — only when the server sends the bucket. */
const SHARES_COLUMN: DataColumn<DailyAdminPoint> = {
  key: "share_transfers_minutes",
  header: REPORT_SHARES_COPY.clubShares,
  align: "right",
  cell: (r) => <NetMinutes value={r.share_transfers_minutes ?? 0} />,
  sortValue: (r) => r.share_transfers_minutes ?? 0,
};

/** R14 J14-2 — what the club gave each day, after Sold — only in a period with a gift in it. */
const GIVEN_COLUMN: DataColumn<DailyAdminPoint> = {
  key: "given_minutes",
  header: D.given,
  align: "right",
  cell: (r) => <Cell><Minutes value={givenMinutes(r)} /></Cell>,
  sortValue: givenMinutes,
};

function dayColumns(shares: boolean, given: boolean): DataColumn<DailyAdminPoint>[] {
  let columns = DAY_COLUMNS;
  if (shares) {
    const at = columns.findIndex((c) => c.key === "reversals_minutes") + 1;
    columns = [...columns.slice(0, at), SHARES_COLUMN, ...columns.slice(at)];
  }
  if (given) {
    const at = columns.findIndex((c) => c.key === "top_ups_minutes") + 1;
    columns = [...columns.slice(0, at), GIVEN_COLUMN, ...columns.slice(at)];
  }
  return columns;
}

function DailyBreakdown({ days }: { days: DailyAdminPoint[] }) {
  const shares = carriesShares(days);
  const given = days.some((d) => givenMinutes(d) > 0);
  return (
    <Section title={D.title} description={COPY.days(days.length)}>
      <DataTable
        label={D.label}
        rows={days}
        rowKey={(r) => r.date}
        defaultSort={{ key: "date", dir: "desc" }}
        emptyTitle={D.empty}
        maxHeight="60vh"
        wrapHeaders
        columns={dayColumns(shares, given)}
      />
      <TableNotes>
        <p className="text-sm text-text-secondary">
          <strong className="font-semibold text-text-primary">Two dates in one row, on purpose.</strong> The minutes columns count the day the minutes moved;
          <strong className="font-semibold text-text-primary"> Courts played</strong> and <strong className="font-semibold text-text-primary">No-shows</strong> count
          the day the court is booked for. A member who books a fortnight ahead is charged today and plays later, so the two
          halves of a row are not about the same bookings. Days are the club&#39;s own, in its configured timezone.
        </p>
        <NetNote what={D.netWhat} />
        {shares ? <p className="text-sm text-text-secondary">{REPORT_SHARES_COPY.clubCaption}</p> : null}
      </TableNotes>
    </Section>
  );
}
