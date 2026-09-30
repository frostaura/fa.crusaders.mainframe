import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { endpoints, type LedgerRow } from "../lib/api";
import { readWholeLedger } from "../lib/adminPaging";
import { clubDayRange, clubToday } from "../lib/clubDay";
import { clubZoneIsKnown } from "../lib/clubZone";
import { formatSignedCredits } from "../lib/utils";
import { LedgerTable } from "../components/LedgerTable";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { Skeleton } from "../components/ui/skeleton";
import { StateBlock } from "../components/ui/state-block";
import { MagnifyingGlass } from "../components/ui/icons";
import { FilterBar, FilterDate, FilterSelect, TableSkeleton, type FilterOption } from "../components/monitoring/parts";
import { ADMIN_LEDGER_TYPES, ledgerTypeLabel } from "../lib/creditAdjustment";
import { LedgerDetailSheet } from "../components/admin/LedgerDetailSheet";
import type { Column } from "../components/wallet/ledgerColumns";

/** F3.8: the admin reads who made each movement and what kind it was, and opens any row. */
const ADMIN_COLUMNS: Column[] = ["time", "from", "to", "category", "actor", "comment", "amount"];

// Every type the backend writes, pinned against the C# enum (`ledgerTypes.contract.test.ts`).
// The union in api.ts lacked `AdminTopUp`, so desk top-ups could not be filtered (R2 F3-5).
const TYPES = ADMIN_LEDGER_TYPES;

/** "All types" first, then every ledger type by the name an admin reads, never the enum. */
const TYPE_OPTIONS: FilterOption[] = [
  { value: "", label: "All types" },
  ...TYPES.map((t) => ({ value: t, label: ledgerTypeLabel(t) })),
];

/**
 * The filters live in the URL, because `reporting.md` § Filters says they do:
 * <i>"Filter state lives in the URL query string so a report can be shared / bookmarked."</i>
 *
 * <p>
 * They did not. Opening <code>/admin/ledger?userId=&lt;a member&gt;</code> returned all 73
 * movements in the tenant rather than that member's 29, adding <code>&amp;type=TopUp</code>
 * changed nothing, and the in-page controls — which filter correctly — never wrote anything
 * back, so <code>p.url()</code> stayed <code>/admin/ledger</code> whatever was on screen. A
 * report the admin could see and could not send to anybody.
 * </p>
 *
 * <p>
 * So the query string is the single source of truth here rather than a copy of it kept in
 * sync: there is no `useState` for a filter, the inputs read the URL and write the URL, and
 * <code>replace</code> keeps a debounced keystroke out of the history stack. The dates are
 * written on arrival too — a bookmark saying "the last 30 days" resolves to a different
 * period next week, which is not what sharing a report means.
 * </p>
 */
const DEFAULT_FROM_DAYS = 30;

export default function AdminLedgerPage() {
  const [params, setParams] = useSearchParams();
  const [opened, setOpened] = useState<LedgerRow | null>(null);

  const { from, to, type, userQuery, userId } = filtersOf(params);
  const setFilter = (key: string, value: string) => setParams((prev) => withFilter(prev, key, value), { replace: true });

  usePinnedRange(params, setParams, from, to);

  const { rows, loading, loadError, readAt, complete, load } = useLedgerRead({ from, to, type, userId });

  const filtered = useMemo(() => byName(rows, userQuery), [rows, userQuery]);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Transactions"
        description="Every credit movement across the club — top-ups, charges, refunds, penalties and manual adjustments."
        actions={<RefreshButton onRefresh={() => void load()} loading={loading} />}
        freshness={<Freshness at={readAt} />}
      />

      <div className="flex flex-col gap-3">
        <LedgerFilterBar from={from} to={to} type={type} query={userQuery} onChange={setFilter} />

        {userId && (
          // ?userId= is answered by the API and had no way in from the screen, so a link to
          // one member's movements silently showed the whole club's. It is honoured now, and
          // said out loud — an unexplained short list is the same defect wearing a filter.
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="info">Showing one member’s movements</Badge>
            <Button variant="ghost" size="sm" type="button" onClick={() => setFilter("userId", "")}>
              Show everyone
            </Button>
          </div>
        )}
      </div>

      <StateBlock
        loading={loading && rows === null}
        error={loadError}
        action="read those movements"
        failedCaveat="Check the dates and try again."
        onRetry={() => void load()}
        skeleton={<TableSkeleton rows={6} />}
      >
        <Card className="gap-0 pb-0 sm:gap-0 sm:pb-0" aria-busy={loading || undefined}>
          {/* As many columns as fit a 9rem figure (R3 X-4): two fixed columns at 200% text on a
              phone were narrower than "+68473.00", and the page scrolled sideways. */}
          <CardContent className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 pb-4 text-sm">
            <LedgerTotals rows={filtered} complete={complete} loading={loading} readSoFar={rows?.length ?? 0} />
          </CardContent>
          <LedgerTable
            rows={filtered}
            columns={ADMIN_COLUMNS}
            onOpen={setOpened}
            emptyText="No movements match these filters."
            label="Club ledger"
            wideOnly={["comment"]}
          />
        </Card>
      </StateBlock>
      <LedgerDetailSheet row={opened} onClose={() => setOpened(null)} />
    </PageShell>
  );
}

/** The filters the URL carries. Club dates, in the club's zone (A4-7): "today" at 00:30 is the club's today, not UTC's. */
function filtersOf(params: URLSearchParams) {
  return {
    from: params.get("from") ?? clubToday(-DEFAULT_FROM_DAYS),
    to: params.get("to") ?? clubToday(0),
    type: params.get("type") ?? "",
    userQuery: params.get("q") ?? "",
    userId: params.get("userId") ?? "",
  };
}

/**
 * The query string with one filter set. An empty date input means UNBOUNDED and an empty select
 * means "all types"; both are states worth being able to share, so a date is written as an empty
 * value rather than dropped, which would read back as "unset" and silently restore the default
 * window. An empty type, search or member is dropped.
 */
function withFilter(prev: URLSearchParams, key: string, value: string): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (value === "" && DROPPED_WHEN_EMPTY.has(key)) next.delete(key);
  else next.set(key, value);
  return next;
}

const DROPPED_WHEN_EMPTY = new Set(["type", "q", "userId"]);

/**
 * Pin the window the admin is actually looking at into the URL, once, so the link they copy
 * means the same thing tomorrow.
 */
function usePinnedRange(
  params: URLSearchParams, setParams: ReturnType<typeof useSearchParams>[1], from: string, to: string,
) {
  const pinned = useRef(false);
  useEffect(() => {
    if (pinned.current) return;
    pinned.current = true;
    if (params.has("from") && params.has("to")) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!next.has("from")) next.set("from", from);
      if (!next.has("to")) next.set("to", to);
      return next;
    }, { replace: true });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);
}

/** The name search, over the rows read: subject, actor, from and to. */
function byName(rows: LedgerRow[] | null, query: string): LedgerRow[] {
  if (!rows) return [];
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => [r.subjectName, r.actorName, r.from, r.to].some((v) => v.toLowerCase().includes(q)));
}

/** The four totals, only ever over a complete read of the range (R4 carry-over). */
function LedgerTotals({ rows, complete, loading, readSoFar }: {
  rows: LedgerRow[]; complete: boolean; loading: boolean; readSoFar: number;
}) {
  const totals = useMemo(() => {
    const credits = rows.filter((r) => r.signedAmountCredits > 0).reduce((s, r) => s + r.amountCredits, 0);
    const debits = rows.filter((r) => r.signedAmountCredits < 0).reduce((s, r) => s + r.amountCredits, 0);
    return { credits, debits, net: credits - debits, count: rows.length };
  }, [rows]);
  // Every signed figure through formatSignedCredits, never a sign composed around
  // formatCredits.
  //
  // These two read "+" + formatCredits(...) and "−" + formatCredits(...), so the sign
  // was decided by which tile it was rather than by the figure in it, and a filter
  // that matched nothing rendered "+0.00 cr" beside "−0.00 cr" on the one screen whose
  // whole job is reconciling money. A signed zero reads as a movement that did not
  // happen. formatSignedCredits already answers this — its own comment records the
  // reports card that made the identical mistake and was brought through it — and its
  // zero arm is why the fix is here at the formatter boundary rather than in a guard on
  // the empty case: a genuine zero-valued adjustment row is wrong in exactly the same
  // way, with a table full of rows underneath it.
  //
  // Debits are summed as a MAGNITUDE (amountCredits of the rows whose signed amount
  // is negative), so the negation is what tells the formatter which direction this tile
  // is counting. The sign on screen is then the sign of a number, which is the property
  // that cannot drift.
  //
  return (
    <>
      {complete || loading ? (
        <>
          <Stat label="Movements" value={complete ? String(totals.count) : null} />
          <Stat label="Credits" value={complete ? formatSignedCredits(totals.credits) : null} tone={toneOf(totals.credits)} />
          <Stat label="Debits" value={complete ? formatSignedCredits(-totals.debits) : null} tone={toneOf(-totals.debits)} />
          <Stat label="Net" value={complete ? formatSignedCredits(totals.net) : null} tone={toneOf(totals.net)} />
        </>
      ) : (
        <p className="col-span-full text-text-secondary">{LEDGER_TOO_MANY(readSoFar)}</p>
      )}
    </>
  );
}

/** From, To, Type and the name search — each writing the URL. */
function LedgerFilterBar({ from, to, type, query, onChange }: {
  from: string; to: string; type: string; query: string; onChange: (key: string, value: string) => void;
}) {
  return (
    <FilterBar>
      <FilterDate label="From" value={from} onChange={(next) => onChange("from", next)} />
      <FilterDate label="To" value={to} onChange={(next) => onChange("to", next)} />
      <FilterSelect
        id="ledger-type"
        label="Type"
        value={type}
        options={TYPE_OPTIONS}
        onChange={(next) => onChange("type", next)}
      />
      {/* No rem floor (R3 X-4): min-w-48 was 384px at 200% text, wider than a phone. */}
      <Field controlId="ledger-search" className="min-w-0 flex-[2_1_14rem]">
        <FieldLabel>Search (name)</FieldLabel>
        <div className="relative">
          <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            className="pl-9"
            placeholder="Member or admin name"
            value={query}
            onChange={(e) => onChange("q", e.target.value)}
          />
        </div>
      </Field>
    </FilterBar>
  );
}

/**
 * The range's movements, read whole (R4 carry-over), in club days (A4-7). Auto-applies: the
 * first read is immediate, later filter changes are debounced. A read superseded by a newer one
 * is dropped, so a slow first page never lands over a later filter's rows.
 */
function useLedgerRead({ from, to, type, userId }: { from: string; to: string; type: string; userId: string }) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  /** Whether `rows` is the WHOLE range: totals are shown only over a complete read. */
  const [complete, setComplete] = useState(false);
  const loadSeq = useRef(0);

  const load = async () => {
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    setLoading(true);
    setComplete(false);
    try {
      // The club's day needs the club's zone; settings carry it (and the API layer notes it).
      if (!clubZoneIsKnown()) await endpoints.adminSettingsGet().catch(() => undefined);
      const range = clubDayRange(from, to);
      const { rows: all, complete: whole } = await readWholeLedger({
        // An empty "From" is UNBOUNDED: the server's own default is 90 days back, which is not
        // what an emptied box says. The club's first movement is later than this.
        from: range.from ?? UNBOUNDED_FROM,
        to: range.to,
        type: type || undefined,
        userId: userId || undefined,
      }, {
        // Rows appear as each page lands; the totals wait for the last one.
        onPage: (sofar) => { if (current()) setRows(sofar); },
      });
      if (!current()) return;
      setRows(all);
      setComplete(whole);
      setLoadError(null);
      setReadAt(Date.now());
    } catch (e) {
      if (!current()) return;
      // And the stale rows go with it. Showing the last successful answer under a failed
      // filter is worse than showing nothing, because nothing on screen says it is stale.
      // The failure is ON the page, with a retry, where the table was: a toast floats away,
      // and an empty table under a failed read reads "no movements" (R12).
      setRows(null);
      setLoadError(e);
    }
    finally { if (current()) setLoading(false); }
  };

  // Auto-apply filters: debounce server reload as the user edits date/type.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; load(); return; }
    const h = window.setTimeout(load, 300);
    return () => window.clearTimeout(h);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [from, to, type, userId]);

  return { rows, loading, loadError, readAt, complete, load };
}

/**
 * The colour of a total, taken from its sign — for the same reason the sign is.
 *
 * <p>
 * The tiles were coloured by which tile they were: Credits always `success`, Debits always
 * `warning`, and Net asked <code>>= 0</code>, so a club that had neither taken nor given
 * anything in the period was painted green as though it had come out ahead. That is the "+"
 * defect one layer down — a colour is a claim about direction, and zero has no direction —
 * and leaving it would have meant an uncoloured sign sitting inside a coloured figure.
 * </p>
 *
 * <p>
 * <code>-0 === 0</code> in JavaScript, so a negated zero arriving from the Debits tile lands
 * on the same arm as a plain one rather than on the negative branch.
 * </p>
 */
function toneOf(value: number): "success" | "warning" | undefined {
  if (value === 0) return undefined;
  return value > 0 ? "success" : "warning";
}

/** A total, or a skeleton while the range is still being read — never a sum over part of it. */
function Stat({ label, value, tone }: { label: string; value: string | null; tone?: "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-success-strong" : tone === "warning" ? "text-warning-strong" : "text-text-primary";
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{label}</p>
      {value === null
        ? <Skeleton className="mt-1 h-7 w-24 max-w-full" aria-label={`${label}: still counting`} />
        : <p data-ledger-total="" className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>}
    </div>
  );
}

/** The earliest instant an emptied "From" asks for: before any club's first movement. */
const UNBOUNDED_FROM = "2000-01-01T00:00:00.000Z";

/** The read stopped at its cap, so no total is shown: a sum over part of a range is a wrong sum. */
const LEDGER_TOO_MANY = (n: number) =>
  `These dates hold more than ${n.toLocaleString("en-ZA")} movements — too many to total here. Narrow the dates to see the totals.`;
