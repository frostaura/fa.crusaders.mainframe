import { useEffect, useState } from "react";
import { endpoints, type WalletReport, type RevenueReport, type DailyAdminPoint, type DailyMePoint, type UtilisationRow } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { useToast } from "../components/Toast";
import { Carousel, type CarouselSlide } from "../components/Carousel";
import { DataTable, type DataColumn } from "../components/DataTable";
import { formatCredits, formatMinutes, formatSignedCredits, formatZar } from "../lib/utils";
import {
  RevenueAreaChart, DailyFlowBarChart, BookingsLineChart, CourtsRevenueBarChart,
  NoShowDonut, MyBalanceLineChart, MyFlowBarChart, MyBookingsBarChart,
} from "../components/Charts";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export default function ReportsPage() {
  const auth = useAuth();
  const toast = useToast();
  const isAdmin = auth.status === "authenticated" && auth.isAdmin;
  const [from, setFrom] = useState(() => ymd(new Date(Date.now() - 30 * 86400000)));
  const [to, setTo] = useState(() => ymd(new Date()));

  const [wallet, setWallet] = useState<WalletReport | null>(null);
  const [revenue, setRevenue] = useState<RevenueReport | null>(null);
  const [util, setUtil] = useState<{ from: string; to: string; by_court: UtilisationRow[] } | null>(null);
  const [noShow, setNoShow] = useState<{ total: number; no_show: number; no_show_pct: number } | null>(null);
  const [dailyAdmin, setDailyAdmin] = useState<DailyAdminPoint[] | null>(null);
  const [dailyMe, setDailyMe] = useState<DailyMePoint[] | null>(null);

  // Declared above `load` deliberately. lizard reads a bare `<` in a .tsx file as a JSX
  // open tag and swallows everything after it into whichever nested function it was last
  // inside, so ONE function per component absorbs the whole render body and scores in the
  // hundreds. Here that function is `load`, which is on the complexity baseline for
  // exactly that reason; a new function declared after it steals the attribution and trips
  // the gate on a line nobody touched.
  const downloadCsv = async () => {
    try {
      const { blob, filename } = await endpoints.walletCsv(`${from}T00:00:00Z`, `${to}T23:59:59Z`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.push({ tone: "danger", text: "Couldn't build that CSV. Try a shorter date range." });
    }
  };

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
        { label: "Net revenue", value: revenue ? formatZar(revenue.net_zar) : "—", tone: "accent" as const },
        { label: "Top-ups", value: revenue ? formatCredits(revenue.gross_topups_credits) : "—", tone: "success" as const },
        { label: "Bookings", value: dailyAdmin ? String(dailyAdmin.reduce((s, d) => s + d.bookings, 0)) : "—", tone: "neutral" as const },
        { label: "No-show rate", value: noShow ? `${noShow.no_show_pct.toFixed(1)}%` : "—", tone: noShow && noShow.no_show_pct > 5 ? "warning" as const : "neutral" as const },
      ]
    : [
        { label: "Top-ups", value: wallet ? formatCredits(wallet.top_ups_credits) : "—", tone: "success" as const },
        { label: "Spent", value: wallet ? formatCredits(wallet.spent_credits) : "—", tone: "accent" as const },
        { label: "Refunds (net)", value: wallet ? formatCredits(wallet.refunds_credits) : "—", tone: "neutral" as const },
        // Attendance, which nothing in the product showed anywhere — `reporting.md` has
        // promised "Time on court" since it was written.
        { label: "Time on court", value: wallet ? formatMinutes(wallet.minutes_on_court) : "—", tone: "neutral" as const },
      ];

  // Summed from the daily buckets the server already aggregates, not from raw rows —
  // `reporting.md` § Implementation notes forbids client-side aggregation over large
  // datasets, and a bounded day series is the pre-aggregation it asks for.
  const clubTotals = dailyAdmin && sumDays(dailyAdmin);

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
        {/* Fetched with the session token and saved from the blob. A plain `<a download>`
            made the browser navigate to the endpoint on its own with no Authorization
            header: the API answered 400 tenant_unresolved as JSON, the download started
            and cancelled itself, and the page looked identical before and after. */}
        <Button variant="outline" type="button" className="ml-auto" onClick={downloadCsv}>Download wallet CSV</Button>
      </div>

      {/* Tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((t) => <Tile key={t.label} {...t} />)}
      </div>

      {/*
        The club's own money, including the figure that was on no screen at all.

        An admin opening /reports got a "My wallet — totals" panel showing the ADMIN'S wallet
        — all zeros, permanently, because `feature-spec.md` §8 makes a desk account's balance
        zero by design ("it never plays") — sitting in the middle of the club-wide report and
        ending with "…it is exactly what your balance moved by". Inert furniture. Meanwhile
        the club's report carried Top-ups, Charges, Refunds and Penalties and no ADJUSTMENTS
        anywhere: a tenant with 2,525.50 credits handed out by the desk could see that figure
        on a member's own report and on Transactions, and nowhere on the report whose subject
        is where the club's money went.
      */}
      {isAdmin && clubTotals && (
        <Card>
          <h2 className="font-semibold mb-3">Club money — totals</h2>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="Top-ups" value={formatSignedCredits(clubTotals.topUps)} />
            <Stat label="Charges" value={formatSignedCredits(-clubTotals.charges)} />
            <Stat label="Refunds (net)" value={formatSignedCredits(clubTotals.refunds)} />
            <Stat label="Penalties (net)" value={formatSignedCredits(-clubTotals.penalties)} />
            <Stat label="Adjustments" value={formatSignedCredits(clubTotals.adjustments)} />
            <Stat label="Courts played" value={String(clubTotals.bookings)} />
            <Stat label="No-shows" value={String(clubTotals.noShows)} />
            <Stat label="Days" value={String(clubTotals.days)} />
          </dl>
          <p className="mt-3 text-xs text-text-muted">
            Credit held by members moved by <strong className="font-mono">{formatSignedCredits(clubTotals.net)}</strong> over
            this period — top-ups − charges + refunds − penalties + adjustments, which is every ledger movement in the club
            summed. <strong>Adjustments</strong> is what the desk added or took back by hand.
          </p>
        </Card>
      )}

      {/* Personal wallet summary — sits right under the tiles for at-a-glance context.
          Members only: an admin's own wallet is zero by design and says nothing about the club. */}
      {!isAdmin && wallet && (
        <Card>
          <h2 className="font-semibold mb-3">My wallet — totals</h2>
          {/*
            Every bucket a movement can land in, because this has to reconcile. It showed
            top-ups, spend, refunds and a penalty COUNT and nothing else, so a member with
            2,500 credits of admin adjustments read "0 in, 950 out, 100 back" — reading as
            −850 — beside a header that said 1,635, with nothing on the page accounting for
            the difference. The net line at the bottom is the arithmetic, spelled out.
          */}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {/*
              Every one of these goes through `formatSignedCredits`, including the two
              whose direction is fixed. Hardcoding "+" and "−" around `formatCredits`
              looked equivalent and was not: a period with no spend and no penalties read
              "−0.00 cr", and on the one screen whose job is to reconcile, a signed zero
              reads as a movement that did not happen. Spend and penalties leave the
              wallet, so they are negated rather than labelled negative.
            */}
            <Stat label="Top-ups" value={formatSignedCredits(wallet.top_ups_credits)} />
            <Stat label="Spent" value={formatSignedCredits(-wallet.spent_credits)} />
            <Stat label="Refunds (net)" value={formatSignedCredits(wallet.refunds_credits)} />
            <Stat label="Penalties" value={formatSignedCredits(-wallet.penalties_credits)} />
            <Stat label="Adjustments" value={formatSignedCredits(wallet.adjustments_credits)} />
            <Stat label="Penalty count" value={String(wallet.penalty_count)} />
            <Stat label="Bookings played" value={`${wallet.attended_bookings} · ${formatMinutes(wallet.minutes_on_court)}`} />
            <Stat label="Movements" value={String(wallet.count)} />
          </dl>
          <p className="mt-3 text-xs text-text-muted">
            Net movement over this period: <strong className="font-mono">{formatSignedCredits(wallet.net_movement_credits)}</strong>.
            That is top-ups − spend + refunds − penalties + adjustments, and it is exactly what your balance moved by.
          </p>
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
            defaultSort={{ key: "revenue_credits", dir: "desc" }}
            emptyTitle="No bookings in this window."
            columns={[
              { key: "court_name", header: "Court", cell: (r) => r.court_name },
              { key: "bookings", header: "Bookings", align: "right", cell: (r) => r.bookings, sortValue: (r) => r.bookings },
              // Minutes, not slices. A 60-minute walk-up is SliceCount 1 and was counted
              // the same as a 15-minute booking, so the column mixed units.
              { key: "booked_minutes", header: "Booked", align: "right", cell: (r) => formatMinutes(r.booked_minutes), sortValue: (r) => r.booked_minutes },
              { key: "quoted_credits", header: "Quoted", align: "right", cell: (r) => formatCredits(r.quoted_credits), sortValue: (r) => r.quoted_credits },
              { key: "revenue_credits", header: "Kept", align: "right", cell: (r) => formatCredits(r.revenue_credits), sortValue: (r) => r.revenue_credits },
            ] satisfies DataColumn<UtilisationRow>[]}
          />
          <p className="mt-2 text-xs text-text-muted">
            <strong>Quoted</strong> is the price at booking. <strong>Kept</strong> is what the club actually took once refunds,
            penalties and any desk adjustments naming the booking are netted — for a no-show that is the penalty, not the price.
          </p>
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
              { key: "top_ups_credits", header: "Top-ups", align: "right", cell: (r) => cr(r.top_ups_credits), sortValue: (r) => r.top_ups_credits },
              { key: "booking_charges_credits", header: "Charges", align: "right", cell: (r) => cr(r.booking_charges_credits), sortValue: (r) => r.booking_charges_credits },
              { key: "refunds_credits", header: "Refunds (net)", align: "right", cell: (r) => <NetCredits value={r.refunds_credits} />, sortValue: (r) => r.refunds_credits },
              { key: "penalties_credits", header: "Penalties (net)", align: "right", cell: (r) => <NetCredits value={r.penalties_credits} />, sortValue: (r) => r.penalties_credits },
              { key: "adjustments_credits", header: "Adjustments", align: "right", cell: (r) => <NetCredits value={r.adjustments_credits} />, sortValue: (r) => r.adjustments_credits },
              // "Courts played", not "Bookings". These two columns count the day the court
              // is USED; the four money columns to their left count the day the money MOVED.
              // Under a 14-day advance window those are routinely different days, which is
              // how one row came to read "Charges 2300.00 cr · Bookings 6" — 46 slices' worth
              // of money beside six courts. The header says which clock it is on and the
              // footnote below spells the consequence out.
              { key: "bookings", header: "Courts played", align: "right", cell: (r) => r.bookings, sortValue: (r) => r.bookings },
              { key: "no_shows", header: "No-shows", align: "right", cell: (r) => r.no_shows, sortValue: (r) => r.no_shows },
            ] satisfies DataColumn<DailyAdminPoint>[]}
          />
          <p className="mt-2 text-xs text-text-muted">
            <strong>Two dates in one row, on purpose.</strong> The money columns count the day the money moved;
            <strong> Courts played</strong> and <strong>No-shows</strong> count the day the court is booked for. A member
            who books a fortnight ahead is charged today and plays later, so the two halves of a row are not about the
            same bookings. Days are the club's own, in its configured timezone.
          </p>
          <NetNote what="Refunds, penalties and adjustments" />
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
              { key: "top_ups_credits", header: "Top-ups", align: "right", cell: (r) => cr(r.top_ups_credits), sortValue: (r) => r.top_ups_credits },
              { key: "spent_credits", header: "Spent", align: "right", cell: (r) => cr(r.spent_credits), sortValue: (r) => r.spent_credits },
              { key: "refunds_credits", header: "Refunds (net)", align: "right", cell: (r) => <NetCredits value={r.refunds_credits} />, sortValue: (r) => r.refunds_credits },
              { key: "bookings", header: "Bookings", align: "right", cell: (r) => r.bookings, sortValue: (r) => r.bookings },
              { key: "balance_credits", header: "Balance", align: "right", cell: (r) => cr(r.balance_credits), sortValue: (r) => r.balance_credits },
            ] satisfies DataColumn<DailyMePoint>[]}
          />
          <NetNote what="Refunds" />
        </Card>
      )}

    </div>
  );
}

/**
 * The club's period totals, summed over the server's daily buckets.
 *
 * <p>
 * Declared as a standalone function AFTER the component for the lizard reason recorded on
 * `downloadCsv`: a `.tsx` function declared between two others steals the attribution for
 * the component's whole render body.
 * </p>
 */
function sumDays(days: DailyAdminPoint[]) {
  const sum = (pick: (d: DailyAdminPoint) => number) => days.reduce((s, d) => s + pick(d), 0);
  const topUps = sum((d) => d.top_ups_credits);
  const charges = sum((d) => d.booking_charges_credits);
  const refunds = sum((d) => d.refunds_credits);
  const penalties = sum((d) => d.penalties_credits);
  const adjustments = sum((d) => d.adjustments_credits);
  return {
    topUps, charges, refunds, penalties, adjustments,
    bookings: sum((d) => d.bookings),
    noShows: sum((d) => d.no_shows),
    days: days.length,
    // The same arithmetic the member's own net line uses, so the two screens cannot
    // disagree about what "net" means.
    net: topUps - charges + refunds - penalties + adjustments,
  };
}

/**
 * Every column this formats is credit-denominated, and it used to print a rand sign over
 * all eight of them. Credits are the unit of account; rand is only ever what was paid at
 * the till. Kept as a local alias so the call sites stay short.
 */
const cr = (v: number) => formatCredits(v);
const prettyDate = (s: string) => new Date(s + "T00:00:00Z").toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });

/**
 * A net credit figure, signed, with a negative one marked.
 *
 * <p>
 * Settlement-model I11: a correction posts a new row of the same type with the opposite
 * sign rather than editing the row it corrects, because a single netted row cannot
 * answer "how much penalty did I pay?" — the question a disputed settlement asks. The
 * accepted consequence is that a period bucket goes negative whenever a reversal lands
 * in a different day's bucket from the sweep it reverses: a member who was swept as a
 * no-show on Tuesday and whose attendance upload arrived on Wednesday has a positive
 * penalty on Tuesday and a negative one on Wednesday.
 * </p>
 *
 * <p>
 * So a minus here is the netting working, and the number is shown as it is rather than
 * as its magnitude. Marking it amber says "look at this day" without saying "error";
 * printing <code>|x|</code> instead would make the two days indistinguishable and hide
 * the only trace on this screen that a reversal happened at all.
 * </p>
 */
function NetCredits({ value }: { value: number }) {
  return <span className={value < 0 ? "text-warning-strong" : undefined}>{formatCredits(value)}</span>;
}

/** Says once, under the table, what the "(net)" in those column headers means. */
function NetNote({ what }: { what: string }) {
  return (
    <p className="mt-2 text-xs text-text-muted">
      {what} are net. A reversal is posted as an opposite-sign row on the day it lands, so a day reads negative when
      more was reversed on it than posted — usually because the sweep and the reversal fell on different days.
    </p>
  );
}

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
