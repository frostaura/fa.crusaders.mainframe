import { Suspense, lazy, useRef, type ReactNode } from "react";
import { endpoints, type DailyMePoint, type WalletReport } from "../lib/api";
import { memberReads, type WalletActivity } from "../lib/offline/memberReads";
import { useKeptReport } from "../lib/offline/useKeptReport";
import { StaleNotice } from "../components/shell/StaleNotice";
import { OfflineNothingKept } from "../lib/offline/OfflineNothingKept";
import { StillTrying } from "../lib/offline/StillTrying";
import { OFFLINE_COPY } from "../lib/offline/offlineCopy";
import { cn } from "../lib/utils";
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
          {/* R8 L8-6 — wraps inside the card: nowrap, it pushed a 320 phone at 200 % 11px sideways. */}
          <Button variant="outline" className="max-w-full whitespace-normal" onClick={() => void csv.run()} pending={csv.pending} icon={<DownloadSimple aria-hidden="true" />}>
            Download CSV
          </Button>
        </RangeToolbar>
      </div>
      {/* A refresh that failed keeps the figures it had, and says so — and when — above them. */}
      <StaleNotice stale={report.stale} readAt={report.readAt} offline={report.offline} />
      {/* R6 X6-4 — offline, and this period was never drawn on this phone: said as offline. */}
      {/* R10 X10-1 — a first read that has not answered says, after a few seconds, it is still trying. */}
      {data === null && report.loading ? <StillTrying /> : null}
      {data === null && report.error !== null && report.offline ? <OfflineNothingKept line={OFFLINE_COPY.nothingKept.activity} /> : (
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
      )}
    </PageShell>
  );
}

function ActivityBody({ data }: { data: WalletActivity }) {
  const { wallet, days } = data;
  const tiles: Tile[] = [
    // R7 E7-7 — signed as the Totals card signs the same figures: the Spent tile read "1 h" above
    // a Totals row reading "−1 h" for the one amount.
    { label: ACTIVITY_COPY.bought, value: <MinutesFigure value={wallet.top_ups_minutes} signed />, tone: "success" },
    { label: ACTIVITY_COPY.spent, value: <MinutesFigure value={-wallet.spent_minutes} signed />, tone: "accent" },
    { label: ACTIVITY_COPY.refunds, value: <MinutesFigure value={wallet.refunds_minutes} signed />, tone: "neutral" },
    // Attendance, which nothing in the product showed anywhere — `reporting.md` has promised
    // "Time on court" since it was written. A duration, so unsigned; with its spoken twin (X7-6).
    { label: "Time on court", value: <MinutesFigure value={wallet.minutes_on_court} />, tone: "neutral" },
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
            Net movement over this period: <strong className="font-semibold tabular-nums text-text-primary"><MinutesFigure value={wallet.net_movement_minutes} signed /></strong>.{" "}
            {/* R7 J7-8 — the space above is explicit: a sentence starting on the next JSX line collapses to "min.That". */}
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
        <Stat label="Bookings played" value={<>{wallet.attended_bookings} · <MinutesFigure value={wallet.minutes_on_court} /></>} />
        <Stat label="Movements" value={String(wallet.count)} />
      </TotalsCard>
    </Section>
  );
}

/**
 * R7 J7-2 — a day's row, with the buckets the API added so a row adds up to what the balance moved:
 * shares, penalties, adjustments, reversals and the day's net. Optional — an API from before them
 * sends none. (Widened here until `lib/api.ts`'s `DailyMePoint` carries them.)
 */
type DayPoint = DailyMePoint & {
  penalties_minutes?: number; adjustments_minutes?: number; reversals_minutes?: number;
  share_transfers_minutes?: number; net_movement_minutes?: number;
};

/** The daily table's headers beyond the totals' own words. */
export const DAY_COPY = {
  penalties: "Penalties (net)",
  adjustments: "Adjustments",
  reversals: "Reversals",
  shares: REPORT_SHARES_COPY.memberShares,
  net: "Net",
  bookings: "Bookings",
  balance: "Balance",
} as const;

type DayKey = "top_ups_minutes" | "spent_minutes" | "refunds_minutes" | "penalties_minutes" | "adjustments_minutes" | "reversals_minutes" | "share_transfers_minutes" | "net_movement_minutes";

/**
 * A movement column: every figure SIGNED (in +, out −), so a row reads as the sum it is — the old
 * table printed Bought and Spent bare beside a signed Refunds and left the rest out, and no row
 * added up to its balance change. `sign` turns a magnitude the API sends (spent, penalties) into
 * the movement it was.
 */
function movement(key: DayKey, header: string, sign: 1 | -1 = 1): DataColumn<DayPoint> {
  const value = (r: DayPoint) => sign * (r[key] ?? 0);
  return { key, header, align: "right", cell: (r) => <Cell><MinutesFigure value={value(r)} signed /></Cell>, sortValue: value };
}

/** Columns for the buckets that are optional on the wire: drawn only when the period moved by them. */
const OPTIONAL_DAY_COLUMNS: { key: DayKey; column: DataColumn<DayPoint> }[] = [
  { key: "penalties_minutes", column: movement("penalties_minutes", DAY_COPY.penalties, -1) },
  { key: "adjustments_minutes", column: movement("adjustments_minutes", DAY_COPY.adjustments) },
  { key: "reversals_minutes", column: movement("reversals_minutes", DAY_COPY.reversals) },
  { key: "share_transfers_minutes", column: movement("share_transfers_minutes", DAY_COPY.shares) },
];

/** The period's columns: the fixed ones, every optional bucket that moved, then Net when the API sends it. */
function dayColumns(days: DayPoint[]): DataColumn<DayPoint>[] {
  const moved = (key: DayKey) => days.some((d) => typeof d[key] === "number" && d[key] !== 0);
  const hasNet = days.some((d) => typeof d.net_movement_minutes === "number");
  return [
    { key: "date", header: "Date", cell: (r) => <Cell>{prettyDay(r.date)}</Cell>, sortValue: (r) => r.date, width: 130 },
    movement("top_ups_minutes", ACTIVITY_COPY.bought),
    movement("spent_minutes", ACTIVITY_COPY.spent, -1),
    movement("refunds_minutes", ACTIVITY_COPY.refunds),
    ...OPTIONAL_DAY_COLUMNS.filter((c) => moved(c.key)).map((c) => c.column),
    ...(hasNet ? [movement("net_movement_minutes", DAY_COPY.net)] : []),
    { key: "bookings", header: DAY_COPY.bookings, align: "right", cell: (r) => <Cell>{r.bookings}</Cell>, sortValue: (r) => r.bookings },
    { key: "balance_minutes", header: DAY_COPY.balance, align: "right", cell: (r) => <Cell><MinutesFigure value={r.balance_minutes} /></Cell>, sortValue: (r) => r.balance_minutes },
  ];
}

/**
 * R8 L8-4 — the daily table on a phone. `isolate` makes the table one layer below the stuck range
 * bar: its head is sticky (z 20) like the bar, and later in the page, so it painted OVER the bar
 * as it scrolled under it. And the Date column is pinned while the table scrolls sideways — a row
 * of figures with its day scrolled off is a row nobody can read. Whole class names (the scanner).
 */
const DAILY_TABLE = [
  "isolate",
  "[&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-raised [&_tbody_td:first-child]:bg-bg-surface",
  "[&_thead_th:first-child]:left-0 [&_thead_th:first-child]:z-sticky-corner",
].join(" ");

function DailyBreakdown({ days }: { days: DayPoint[] }) {
  return (
    <Section title="Daily breakdown" description={`${days.length} day${days.length === 1 ? "" : "s"}`}>
      <div className={DAILY_TABLE} data-daily-table="">
        <DataTable
          rows={days}
          rowKey={(r) => r.date}
          defaultSort={{ key: "date", dir: "desc" }}
          emptyTitle="No activity in this window."
          maxHeight="60vh"
          columns={dayColumns(days)}
        />
      </div>
      <TableNotes>
        <NetNote what="Refunds" />
      </TableNotes>
    </Section>
  );
}
