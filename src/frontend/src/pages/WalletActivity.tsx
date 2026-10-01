import { Suspense, lazy, useRef, type ReactNode } from "react";
import { endpoints, type DailyMePoint, type WalletReport } from "../lib/api";
import { memberReads, type WalletActivity } from "../lib/offline/memberReads";
import { useKeptReport } from "../lib/offline/useKeptReport";
import { StaleNotice } from "../components/shell/StaleNotice";
import { cn, formatMinutes } from "../lib/utils";
import { MinutesFigure } from "../components/wallet/MinutesFigure";
import { useAsyncAction } from "../lib/useAsyncAction";
import { PageHeader, PageShell, Section } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import { Button } from "../components/ui/button";
import { ChartBar, DownloadSimple } from "../components/ui/icons";
import { DataTable, type DataColumn } from "../components/DataTable";
import { Skeleton } from "../components/ui/skeleton";
import { WalletNav } from "../components/wallet/WalletNav";
import { AutoGrid } from "../components/ui/auto-grid";
import { Card } from "../components/ui/card";
import { useMediaQuery } from "../components/ui/use-media-query";
import { useStickyTop } from "../components/ui/use-sticky-top";
import { REPORT_SHARES_COPY } from "../lib/playersCopy";
import {
  Cell, ChartsCard, NetNote, RangeToolbar, ReportSkeleton, Stat, StatTiles, TableNotes, TotalsCard,
  type Tile,
} from "../components/reports/ReportParts";
import { dayMarkers, prettyDay, useReportRange, type ReportRange } from "../components/reports/range";

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
 * (`WalletNav`), because "where did my minutes go?" is asked from the wallet.
 * </p>
 */
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

/** The most of the scroller the range card may take and still stick. */
const RANGE_STICKY_MAX = 0.3;


export default function WalletActivityPage() {
  const [range, setRange] = useReportRange();
  // R5 M5-6 (lane D2's kept read): drawn from the phone offline and on a revisit, per range.
  const report = useKeptReport(memberReads.walletActivity(dayMarkers(range)));
  const csv = useAsyncAction(() => downloadWalletCsv(range), {
    toast: { failure: "Couldn't build that CSV. Try a shorter date range." },
  });
  const { data } = report;
  const rangeBar = useRef<HTMLDivElement>(null);
  // R5 X5-1: the range sticks by ROOM, not from the `lg` viewport — at 1280 with 200 % text the
  // card was 292–360px of a 744px scroller; on a phone its wrapped presets are a third of the screen.
  const sticks = useStickyTop(rangeBar, true, RANGE_STICKY_MAX);

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
      <div ref={rangeBar} data-range-bar="" data-sticks={sticks || undefined} className={cn("-my-2 py-2", sticks && "sticky top-0 z-sticky bg-bg-app")}>
        <RangeToolbar range={range} onChange={setRange}>
          <Button variant="outline" onClick={() => void csv.run()} pending={csv.pending} icon={<DownloadSimple aria-hidden="true" />}>
            Download CSV
          </Button>
        </RangeToolbar>
      </div>
      {/* A refresh that failed keeps the figures it had, and says so — and when — above them. */}
      <StaleNotice stale={report.stale} readAt={report.readAt} offline={report.offline} />
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

function ActivityBody({ data }: { data: WalletActivity }) {
  const { wallet, days } = data;
  const tiles: Tile[] = [
    { label: ACTIVITY_COPY.bought, value: <MinutesFigure value={wallet.top_ups_minutes} />, tone: "success" },
    { label: ACTIVITY_COPY.spent, value: <MinutesFigure value={wallet.spent_minutes} />, tone: "accent" },
    { label: ACTIVITY_COPY.refunds, value: <MinutesFigure value={wallet.refunds_minutes} />, tone: "neutral" },
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
          <StateBlock empty emptyIcon={ChartBar} emptyTitle="Nothing to chart in this period." emptyHint="Pick a longer range, or come back after your next purchase or booking." />
        )}
      </Section>
      <DailyBreakdown days={days} />
    </>
  );
}

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

/** The page's words (P13: minutes, and "bought" — never "top-ups"). */
export const ACTIVITY_COPY = {
  bought: "Bought",
  spent: "Spent",
  refunds: "Refunds (net)",
  totalsHelp: "Every way minutes moved in or out of your wallet in this period.",
  netSum: "bought − spent + refunds − penalties + adjustments",
} as const;

/**
 * Every bucket a movement can land in, because this has to reconcile. It once showed purchases,
 * spend, refunds and a penalty COUNT and nothing else, so a member with hours of admin
 * adjustments read figures that did not add up to their balance. The net line is the arithmetic,
 * spelled out.
 *
 * <p>
 * Every figure is signed through `lib/minutes`, including the two whose direction is fixed: a
 * hand-made "−" printed "−0" for a period with no spend, and on the one card whose job is to
 * reconcile, a signed zero reads as a movement that did not happen (`minutesSigned(0)` has none).
 * </p>
 */
function WalletTotals({ wallet }: { wallet: WalletReport }) {
  return (
    <Section title="Totals" description={ACTIVITY_COPY.totalsHelp}>
      <TotalsCard
        footnote={(
          <>
            Net movement over this period: <strong className="font-semibold tabular-nums text-text-primary"><MinutesFigure value={wallet.net_movement_minutes} signed /></strong>.
            {`That is ${ACTIVITY_COPY.netSum}`}{typeof wallet.share_transfers_minutes === "number" ? " + shares" : ""}, and it is exactly what your balance moved by.
            {typeof wallet.share_transfers_minutes === "number" ? ` ${REPORT_SHARES_COPY.memberFootnote}` : null}
          </>
        )}
      >
        <Stat label={ACTIVITY_COPY.bought} value={<MinutesFigure value={wallet.top_ups_minutes} signed />} />
        <Stat label={ACTIVITY_COPY.spent} value={<MinutesFigure value={-wallet.spent_minutes} signed />} />
        <Stat label={ACTIVITY_COPY.refunds} value={<MinutesFigure value={wallet.refunds_minutes} signed />} />
        <Stat label="Penalties" value={<MinutesFigure value={-wallet.penalties_minutes} signed />} />
        <Stat label="Adjustments" value={<MinutesFigure value={wallet.adjustments_minutes} signed />} />
        {/* D11 — optional on the wire: an API that predates shares sends neither, and a row
            reading 0 min for a figure the server never sent would be a claim it did not make. */}
        {typeof wallet.share_transfers_minutes === "number" ? (
          <Stat label={REPORT_SHARES_COPY.memberShares} value={<MinutesFigure value={wallet.share_transfers_minutes} signed />} />
        ) : null}
        {typeof wallet.net_court_spend_minutes === "number" ? (
          <Stat label={REPORT_SHARES_COPY.memberNetCourt} value={<MinutesFigure value={wallet.net_court_spend_minutes} />} />
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
  { key: "top_ups_minutes", header: ACTIVITY_COPY.bought, align: "right", cell: (r) => <Cell><MinutesFigure value={r.top_ups_minutes} /></Cell>, sortValue: (r) => r.top_ups_minutes },
  { key: "spent_minutes", header: ACTIVITY_COPY.spent, align: "right", cell: (r) => <Cell><MinutesFigure value={r.spent_minutes} /></Cell>, sortValue: (r) => r.spent_minutes },
  { key: "refunds_minutes", header: ACTIVITY_COPY.refunds, align: "right", cell: (r) => <Cell><MinutesFigure value={r.refunds_minutes} signed /></Cell>, sortValue: (r) => r.refunds_minutes },
  { key: "bookings", header: "Bookings", align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
  { key: "balance_minutes", header: "Balance", align: "right", cell: (r) => <Cell><MinutesFigure value={r.balance_minutes} /></Cell>, sortValue: (r) => r.balance_minutes },
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
