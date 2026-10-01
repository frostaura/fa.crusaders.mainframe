import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { endpoints, type LedgerRow } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { ledgerPage, readLedgerStart, totalsOver, type LedgerFilters, type LedgerTotals as Totals } from "../lib/adminPaging";
import { clubDayRange, clubToday } from "../lib/clubDay";
import { clubZoneIsKnown } from "../lib/clubZone";
import { cn, formatSignedCredits } from "../lib/utils";
import { LedgerTable } from "../components/LedgerTable";
import { StaleNotice } from "../components/shell/StaleNotice";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { AutoGrid } from "../components/ui/auto-grid";
import { ContextBar } from "../components/ui/context-bar";
import { WithAside } from "../components/ui/with-aside";
import { formatClubDayLabel } from "../components/ui/date-picker-day";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { Skeleton } from "../components/ui/skeleton";
import { StateBlock } from "../components/ui/state-block";
import { CaretDown, CaretUp, Funnel, MagnifyingGlass } from "../components/ui/icons";
import { FilterBar, FilterDate, FilterSelect, TableSkeleton, type FilterOption } from "../components/monitoring/parts";
import { ADMIN_LEDGER_TYPES, ledgerTypeLabel } from "../lib/creditAdjustment";
import { LedgerDetailPanel, LedgerDetailSheet } from "../components/admin/LedgerDetailSheet";
import { useBoxAtLeast } from "../components/admin/useBoxAtLeast";
import { LEDGER_COPY } from "../lib/ledgerCopy";
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [boxRef, roomy] = useBoxAtLeast(72);

  const { from, to, type, userQuery, userId } = filtersOf(params);
  const setFilter = (key: string, value: string) => setParams((prev) => withFilter(prev, key, value), { replace: true });

  usePinnedRange(params, setParams, from, to);

  const read = useLedgerRead({ from, to, type, userId });
  const { rows, loading, loadError, readAt, load } = read;

  const filtered = useMemo(() => byName(rows, userQuery), [rows, userQuery]);

  return (
    <PageShell width="full">
      <PageHeader
        title="Transactions"
        description="Every credit movement across the club — top-ups, charges, refunds, penalties and manual adjustments."
        actions={<RefreshButton onRefresh={() => void load()} loading={loading} />}
        freshness={<Freshness at={readAt} />}
      />

      {/* R4 form factor (SPEC §3.9): the filters and the range's totals are ONE bar that stays in
          view while the book scrolls under it (from lg); on a phone the filters fold behind one
          button that says what they are set to, and the bar scrolls away with the page. */}
      <ContextBar position="top" label="Filters and totals" className="max-lg:static">
        <div className="flex min-w-0 flex-[3_1_36rem] flex-col gap-2">
          <FiltersToggle open={filtersOpen} onToggle={() => setFiltersOpen((v) => !v)} from={from} to={to} type={type} />
          <LedgerFilterBar from={from} to={to} type={type} query={userQuery} onChange={setFilter} className={filtersOpen ? "flex" : "hidden lg:flex"} />
        </div>
        {/* As many columns as fit a 9rem figure (R3 X-4): two fixed columns at 200% text on a
            phone were narrower than "+68473.00", and the page scrolled sideways. */}
        <AutoGrid min="stat" max={4} gap="md" aria-busy={loading || undefined} className="min-w-0 flex-[2_1_30rem] text-sm">
          <LedgerTotals totals={shownTotals(read.totals, filtered, userQuery, read.next)} loading={loading} searching={userQuery.trim() !== ""} />
        </AutoGrid>
      </ContextBar>

      {userId && (
        // ?userId= is answered by the API and had no way in from the screen, so a link to
        // one member's movements silently showed the whole club's. It is honoured now, and
        // said out loud — an unexplained short list is the same defect wearing a filter.
        <div className="-mt-4 flex flex-wrap items-center gap-2">
          <Badge tone="info">Showing one member’s movements</Badge>
          <Button variant="ghost" size="sm" type="button" onClick={() => setFilter("userId", "")}>
            Show everyone
          </Button>
        </div>
      )}

      {/* The movement opens BESIDE the book where the box is 72rem (WithAside, placement sheet):
          ↑/↓ walk the rows and the panel follows. Narrower, it opens as the sheet it always was. */}
      <div ref={boxRef} className="min-w-0">
        <WithAside
          aside={<LedgerDetailPanel row={opened} onClose={() => setOpened(null)} />}
          asideLabel={LEDGER_COPY.panelLabel}
          placement="sheet"
          at="72rem"
          // 22rem at 1920 (3xl): every column of the book, the comment too, fits beside it.
          asideWidth="18rem"
        >
          <StaleNotice stale={read.stale} readAt={readAt} />
          <StateBlock
            loading={loading && rows === null}
            error={read.stale ? null : loadError}
            action="read those movements"
            failedCaveat="Check the dates and try again."
            onRetry={() => void load()}
            skeleton={<TableSkeleton rows={6} />}
          >
            <Card className="gap-0 py-0 sm:gap-0 sm:py-0" aria-busy={loading || undefined}>
              <LedgerTable
                rows={filtered}
                columns={ADMIN_COLUMNS}
                onOpen={setOpened}
                selectedId={roomy ? opened?.id ?? null : null}
                emptyText="No movements match these filters."
                label="Club ledger"
                wideOnly={["comment"]}
              />
              <ShowMore read={read} />
            </Card>
          </StateBlock>
        </WithAside>
      </div>
      <LedgerDetailSheet row={roomy ? null : opened} onClose={() => setOpened(null)} />
    </PageShell>
  );
}

/**
 * The phone's way into the filters: one button that says what they are set to — "Filters ·
 * Tue 1 Sep – Thu 1 Oct · All types" — instead of four controls and 330px before the first row.
 * From lg the filters are always out and this is not drawn.
 */
function FiltersToggle({ open, onToggle, from, to, type }: { open: boolean; onToggle: () => void; from: string; to: string; type: string }) {
  const range = `${formatClubDayLabel(from) ?? "Any date"} – ${formatClubDayLabel(to) ?? "any date"}`;
  const kind = TYPE_OPTIONS.find((o) => o.value === type)?.label ?? "All types";
  return (
    <Button
      variant="outline"
      aria-expanded={open}
      aria-controls="ledger-filters"
      onClick={onToggle}
      icon={<Funnel aria-hidden="true" />}
      className="!h-auto min-h-touch w-full justify-start whitespace-normal py-2 text-left lg:hidden"
    >
      <span className="min-w-0 flex-1">{`Filters · ${range} · ${kind}`}</span>
      {open ? <CaretUp size={16} aria-hidden="true" /> : <CaretDown size={16} aria-hidden="true" />}
    </Button>
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

/**
 * The totals the tiles show: the whole range's (the server's) when no name search narrows the
 * rows; with a search, ours over the matching rows — but only once every row is read, because a
 * sum over part of a range is a wrong sum. Null: not known yet.
 */
function shownTotals(range: Totals | null, filtered: LedgerRow[], query: string, next: string | null): Totals | null {
  if (query.trim() === "") return range;
  return next === null ? totalsOver(filtered) : null;
}

/** The four totals (R4 carry-over), or why there are none. */
function LedgerTotals({ totals, loading, searching }: { totals: Totals | null; loading: boolean; searching: boolean }) {
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
  if (!totals && !loading) {
    return <p className="col-span-full text-text-secondary">{searching ? LEDGER_SEARCH_PARTIAL : LEDGER_TOO_MANY}</p>;
  }
  return <>{tilesOf(totals).map((tile) => <Stat key={tile.label} {...tile} />)}</>;
}

/** The four tiles: a figure each, or null (a skeleton) while the totals are not known. */
function tilesOf(totals: Totals | null): Array<{ label: string; value: string | null; tone?: "success" | "warning" }> {
  if (!totals) return ["Movements", "Credits", "Debits", "Net"].map((label) => ({ label, value: null }));
  return [
    { label: "Movements", value: String(totals.count) },
    { label: "Credits", value: formatSignedCredits(totals.credits), tone: toneOf(totals.credits) },
    { label: "Debits", value: formatSignedCredits(-totals.debits), tone: toneOf(-totals.debits) },
    { label: "Net", value: formatSignedCredits(totals.net), tone: toneOf(totals.net) },
  ];
}

/** From, To, Type and the name search — each writing the URL. */
type FilterBarProps = {
  from: string; to: string; type: string; query: string; onChange: (key: string, value: string) => void; className?: string;
};

function LedgerFilterBar(props: FilterBarProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { from, to, type, query, onChange, className } = props;
  return (
    // Inside the bar, not a card of its own: the bar is the surface.
    <FilterBar id="ledger-filters" className={cn("border-0 bg-transparent p-0 shadow-none", className)}>
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
  /** The whole range's totals (the server's, or ours over a complete read); null when not known. */
  const [totals, setTotals] = useState<Totals | null>(null);
  /** The next page's cursor; null once every row of the range is on the page. */
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: null });
  const loadSeq = useRef(0);
  const filters = useRef<LedgerFilters>({});
  /** The filters the rows on screen answer; a re-read of the SAME filters that fails keeps them. */
  const shownFor = useRef<string | null>(null);
  /** The rows on screen are from an earlier read: the last refresh of these filters failed. */
  const [stale, setStale] = useState(false);

  const load = async () => {
    const seq = ++loadSeq.current;
    const current = () => seq === loadSeq.current;
    const asked = `${from}|${to}|${type}|${userId}`;
    setLoading(true);
    // New filters count again from nothing; a refresh of the same ones keeps its totals meanwhile.
    if (shownFor.current !== asked) setTotals(null);
    try {
      // The club's day needs the club's zone; settings carry it (and the API layer notes it).
      if (!clubZoneIsKnown()) await endpoints.adminSettingsGet().catch(() => undefined);
      const range = clubDayRange(from, to);
      filters.current = {
        // An empty "From" is UNBOUNDED: the server's own default is 90 days back, which is not
        // what an emptied box says. The club's first movement is later than this.
        from: range.from ?? UNBOUNDED_FROM,
        to: range.to,
        type: type || undefined,
        userId: userId || undefined,
      };
      const start = await readLedgerStart(filters.current);
      if (!current()) return;
      setRows(start.rows);
      setNext(start.next);
      setTotals(start.totals);
      setMore({ pending: false, error: null });
      setLoadError(null);
      setStale(false);
      shownFor.current = asked;
      setReadAt(Date.now());
    } catch (e) {
      if (!current()) return;
      setLoadError(e);
      // A refresh of the filters the rows already answer keeps them, under "Couldn't refresh —
      // showing what we had at …" (R4, D's StaleNotice): blanking a book already on screen
      // tells the admin less than before. A NEW filter that fails takes the rows with it —
      // the last answer under filters it does not answer is a wrong answer nothing marks (R12).
      if (shownFor.current === asked) { setStale(true); return; }
      setRows(null);
      setStale(false);
    }
    finally { if (current()) setLoading(false); }
  };

  /** The next page of rows, appended; the totals do not move (they were the whole range's). */
  const loadMore = async () => {
    if (!next || more.pending) return;
    const seq = loadSeq.current;
    setMore({ pending: true, error: null });
    try {
      const page = await ledgerPage(filters.current, next);
      if (seq !== loadSeq.current) return;
      setRows((now) => [...(now ?? []), ...page.items]);
      setNext(page.next_cursor);
      setMore({ pending: false, error: null });
    } catch (e) {
      if (seq === loadSeq.current) setMore({ pending: false, error: e });
    }
  };

  // Auto-apply filters: debounce server reload as the user edits date/type.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; load(); return; }
    const h = window.setTimeout(load, 300);
    return () => window.clearTimeout(h);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [from, to, type, userId]);

  return { rows, loading, loadError, readAt, totals, next, more, load, loadMore, stale };
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

/** No totals: an API that sends none, and a range past what the page will read whole. */
const LEDGER_TOO_MANY =
  "These dates hold too many movements to total here. Narrow the dates to see the totals.";

/** A name search over rows not all read yet: its totals would be over part of the range. */
const LEDGER_SEARCH_PARTIAL =
  "The name search covers the movements shown so far. Show them all to see its totals.";

/** "Show more", under the table, while the range has rows not yet on the page. */
function ShowMore({ read }: { read: ReturnType<typeof useLedgerRead> }) {
  if (!read.next) return null;
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border p-4">
      {read.more.error ? <p role="alert" className="text-sm text-danger-strong">{describeFailure(read.more.error, { action: "read more movements" })}</p> : null}
      <Button variant="outline" pending={read.more.pending} onClick={() => void read.loadMore()}>Show more movements</Button>
    </div>
  );
}
