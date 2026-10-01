import { Suspense, lazy, type ReactNode } from "react";
import { endpoints, type DailyMePoint, type WalletReport } from "../lib/api";
import { formatCredits, formatMinutes, formatSignedCredits } from "../lib/utils";
import { useAsyncAction } from "../lib/useAsyncAction";
import { PageHeader, PageShell, Section } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import { Button } from "../components/ui/button";
import { Alert } from "../components/Alert";
import { ChartBar, DownloadSimple } from "../components/ui/icons";
import { DataTable, type DataColumn } from "../components/DataTable";
import { Skeleton } from "../components/ui/skeleton";
import { WalletNav } from "../components/wallet/WalletNav";
import { AutoGrid } from "../components/ui/auto-grid";
import { Card } from "../components/ui/card";
import { useMediaQuery } from "../components/ui/use-media-query";
import { REPORT_SHARES_COPY } from "../lib/playersCopy";
import {
  Cell, ChartsCard, NetCredits, NetNote, RangeToolbar, ReportSkeleton, Stat, StatTiles, TableNotes, TotalsCard,
  type Tile,
} from "../components/reports/ReportParts";
import { dayMarkers, prettyDay, useReport, useReportRange, type ReportRange } from "../components/reports/range";

/*
 * R4 P4-6 — the charts (the chart library, ~125 KB gz) load with the chart card, not with the
 * page: a static import put them in the member route's own chunk, which the service worker
 * precaches for every member at install. The tiles, totals and the daily table need none of it.
 */
const MyBalanceLineChart = lazy(() => import("../components/Charts").then((m) => ({ default: m.MyBalanceLineChart })));
const MyFlowBarChart = lazy(() => import("../components/Charts").then((m) => ({ default: m.MyFlowBarChart })));
const MyBookingsBarChart = lazy(() => import("../components/Charts").then((m) => ({ default: m.MyBookingsBarChart })));

/** A chart when it has arrived; its footprint until then, so the carousel does not jump. */
function LazyChart({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Skeleton aria-hidden="true" className="h-64 w-full" />}>{children}</Suspense>;
}

/**
 * `/wallet/activity` — a member's own report: what came in, what went out, and when they played.
 *
 * <p>
 * This is the member half of the old `/reports`, which forked on `isAdmin` and showed an admin
 * their own permanently-empty wallet in the middle of the club's figures. The split (R16) gives
 * each reader one page with one subject. It sits beside the balance as the wallet's second view
 * (`WalletNav`), because "where did my credit go?" is asked from the wallet.
 * </p>
 */
type Activity = { wallet: WalletReport; days: DailyMePoint[] };

async function loadActivity(markers: { from: string; to: string }): Promise<Activity> {
  const [wallet, days] = await Promise.all([
    endpoints.reportWallet(markers.from, markers.to),
    endpoints.reportDailyMe(markers.from, markers.to),
  ]);
  return { wallet, days };
}

/**
 * Fetched with the session token and saved from the blob. A plain `<a download>` made the
 * browser navigate to the endpoint on its own with no Authorization header: the API answered
 * 400 tenant_unresolved as JSON, the download started and cancelled itself, and the page looked
 * identical before and after.
 */
async function downloadWalletCsv(range: ReportRange): Promise<void> {
  const markers = dayMarkers(range);
  const { blob, filename } = await endpoints.walletCsv(markers.from, markers.to);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const REFRESH_FAILED = "Couldn't refresh these figures — they are from the last read. Try Refresh again.";

export default function WalletActivityPage() {
  const [range, setRange] = useReportRange();
  const report = useReport(range, loadActivity);
  const csv = useAsyncAction(() => downloadWalletCsv(range), {
    toast: { failure: "Couldn't build that CSV. Try a shorter date range." },
  });
  const { data } = report;

  return (
    // R4 form factor (SPEC 3.4): `wide`; the range sticks while the figures scroll, and from lg
    // the charts stand side by side instead of one at a time in a carousel.
    <PageShell width="wide">
      <PageHeader
        title="Wallet activity"
        description="What came in, what went out and when you played, for any period."
        actions={<RefreshButton onRefresh={report.refresh} loading={report.loading && data !== null} />}
        freshness={<Freshness at={report.readAt} />}
      />
      <WalletNav />
      <div data-range-bar="" className="lg:sticky lg:top-0 lg:z-sticky lg:-my-2 lg:bg-bg-app lg:py-2">
        <RangeToolbar range={range} onChange={setRange}>
          <Button variant="outline" onClick={() => void csv.run()} pending={csv.pending} icon={<DownloadSimple aria-hidden="true" />}>
            Download CSV
          </Button>
        </RangeToolbar>
      </div>
      {/* A refresh that failed keeps the figures it had, and says so above them. */}
      {report.error && data ? <Alert tone="warning">{REFRESH_FAILED}</Alert> : null}
      <StateBlock
        loading={report.loading && data === null}
        error={data === null ? report.error : null}
        // One prop, two grammars: the failure reads "Couldn't load your activity", the busy status
        // "Reading your activity…".
        action="load your activity"
        onRetry={report.refresh}
        skeleton={<ReportSkeleton />}
        className="gap-8"
      >
        {data ? <ActivityBody data={data} /> : null}
      </StateBlock>
    </PageShell>
  );
}

function ActivityBody({ data }: { data: Activity }) {
  const { wallet, days } = data;
  const tiles: Tile[] = [
    { label: "Top-ups", value: formatCredits(wallet.top_ups_credits), tone: "success" },
    { label: "Spent", value: formatCredits(wallet.spent_credits), tone: "accent" },
    { label: "Refunds (net)", value: formatCredits(wallet.refunds_credits), tone: "neutral" },
    // Attendance, which nothing in the product showed anywhere — `reporting.md` has promised
    // "Time on court" since it was written.
    { label: "Time on court", value: formatMinutes(wallet.minutes_on_court), tone: "neutral" },
  ];
  return (
    <>
      <StatTiles tiles={tiles} label="This period at a glance" />
      <WalletTotals wallet={wallet} />
      <Section title="Charts">
        {days.length > 0 ? <Charts days={days} /> : (
          <StateBlock empty emptyIcon={ChartBar} emptyTitle="Nothing to chart in this period." emptyHint="Pick a longer range, or come back after your next top-up or booking." />
        )}
      </Section>
      <DailyBreakdown days={days} />
    </>
  );
}

/**
 * Every bucket a movement can land in, because this has to reconcile. It once showed top-ups,
 * spend, refunds and a penalty COUNT and nothing else, so a member with 2,500 credits of admin
 * adjustments read "0 in, 950 out, 100 back" beside a balance of 1,635 with nothing accounting
 * for the difference. The net line is the arithmetic, spelled out.
 *
 * <p>
 * Every figure goes through `formatSignedCredits`, including the two whose direction is fixed:
 * hardcoding "−" around `formatCredits` printed "−0.00 cr" for a period with no spend, and on
 * the one card whose job is to reconcile, a signed zero reads as a movement that did not happen.
 * </p>
 */
/**
 * The three charts: a carousel on a phone, where one at a time is all the width holds, and side
 * by side from lg (an AutoGrid of three 18rem-and-up cards: one row on a wide page) — a desktop paging through three charts in a
 * 1200px box was a carousel for its own sake. One rendering, chosen in JS, so a chart is never
 * drawn twice.
 */
function Charts({ days }: { days: DailyMePoint[] }) {
  const wide = useMediaQuery(LG_UP);
  const slides = [
    { key: "balance", title: "Wallet balance", node: <LazyChart><MyBalanceLineChart data={days} /></LazyChart> },
    { key: "flow", title: "Daily money flow", node: <LazyChart><MyFlowBarChart data={days} /></LazyChart> },
    { key: "bk", title: "My bookings", node: <LazyChart><MyBookingsBarChart data={days} /></LazyChart> },
  ];
  if (!wide) return <ChartsCard slides={slides} />;
  return (
    <AutoGrid min="card" max={3} gap="lg" data-charts-grid="">
      {slides.map((slide) => (
        <Card key={slide.key} className="min-w-0 px-4 sm:px-6">
          <h3 className="text-base font-semibold text-text-primary">{slide.title}</h3>
          {slide.node}
        </Card>
      ))}
    </AutoGrid>
  );
}

const LG_UP = "(min-width: 1024px)";

function WalletTotals({ wallet }: { wallet: WalletReport }) {
  return (
    <Section title="Totals" description="Every way credit moved in or out of your wallet in this period.">
      <TotalsCard
        footnote={(
          <>
            Net movement over this period: <strong className="font-semibold tabular-nums text-text-primary">{formatSignedCredits(wallet.net_movement_credits)}</strong>.
            That is top-ups − spend + refunds − penalties + adjustments{typeof wallet.share_transfers_credits === "number" ? " + shares" : ""}, and it is exactly what your balance moved by.
            {typeof wallet.share_transfers_credits === "number" ? ` ${REPORT_SHARES_COPY.memberFootnote}` : null}
          </>
        )}
      >
        <Stat label="Top-ups" value={formatSignedCredits(wallet.top_ups_credits)} />
        <Stat label="Spent" value={formatSignedCredits(-wallet.spent_credits)} />
        <Stat label="Refunds (net)" value={formatSignedCredits(wallet.refunds_credits)} />
        <Stat label="Penalties" value={formatSignedCredits(-wallet.penalties_credits)} />
        <Stat label="Adjustments" value={formatSignedCredits(wallet.adjustments_credits)} />
        {/* D11 — optional on the wire: an API that predates shares sends neither, and a row
            reading 0.00 for a figure the server never sent would be a claim it did not make. */}
        {typeof wallet.share_transfers_credits === "number" ? (
          <Stat label={REPORT_SHARES_COPY.memberShares} value={formatSignedCredits(wallet.share_transfers_credits)} />
        ) : null}
        {typeof wallet.net_court_spend_credits === "number" ? (
          <Stat label={REPORT_SHARES_COPY.memberNetCourt} value={formatCredits(wallet.net_court_spend_credits)} />
        ) : null}
        <Stat label="Penalty count" value={String(wallet.penalty_count)} />
        <Stat label="Bookings played" value={`${wallet.attended_bookings} · ${formatMinutes(wallet.minutes_on_court)}`} />
        <Stat label="Movements" value={String(wallet.count)} />
      </TotalsCard>
    </Section>
  );
}

const DAY_COLUMNS: DataColumn<DailyMePoint>[] = [
  { key: "date", header: "Date", cell: (r) => <Cell>{prettyDay(r.date)}</Cell>, sortValue: (r) => r.date, width: 130 },
  { key: "top_ups_credits", header: "Top-ups", align: "right", cell: (r) => <Cell>{formatCredits(r.top_ups_credits)}</Cell>, sortValue: (r) => r.top_ups_credits },
  { key: "spent_credits", header: "Spent", align: "right", cell: (r) => <Cell>{formatCredits(r.spent_credits)}</Cell>, sortValue: (r) => r.spent_credits },
  { key: "refunds_credits", header: "Refunds (net)", align: "right", cell: (r) => <NetCredits value={r.refunds_credits} />, sortValue: (r) => r.refunds_credits },
  { key: "bookings", header: "Bookings", align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
  { key: "balance_credits", header: "Balance", align: "right", cell: (r) => <Cell>{formatCredits(r.balance_credits)}</Cell>, sortValue: (r) => r.balance_credits },
];

function DailyBreakdown({ days }: { days: DailyMePoint[] }) {
  return (
    <Section title="Daily breakdown" description={`${days.length} day${days.length === 1 ? "" : "s"}`}>
      <DataTable
        rows={days}
        rowKey={(r) => r.date}
        defaultSort={{ key: "date", dir: "desc" }}
        emptyTitle="No activity in this window."
        maxHeight="60vh"
        columns={DAY_COLUMNS}
      />
      <TableNotes>
        <NetNote what="Refunds" />
      </TableNotes>
    </Section>
  );
}
