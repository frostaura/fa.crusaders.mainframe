import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { endpoints, LEDGER_ENTRY_TYPES, type LedgerRow } from "../lib/api";
import { formatSignedCredits } from "../lib/utils";
import { LedgerTable } from "../components/LedgerTable";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { PageHeader, PageShell } from "../components/ui/page-shell";
import { Freshness, RefreshButton } from "../components/ui/refresh-button";
import { StateBlock } from "../components/ui/state-block";
import { MagnifyingGlass } from "../components/ui/icons";
import { FilterBar, FilterDate, FilterSelect, TableSkeleton, type FilterOption } from "../components/monitoring/parts";
import { LEDGER_TYPE_LABEL } from "../lib/creditAdjustment";

// Derived from the union in api.ts rather than hand-maintained here. This was a
// literal array with no connection to the type, so a ledger type added on the
// backend became unfilterable with nothing to warn anyone.
const TYPES = LEDGER_ENTRY_TYPES;

/** "All types" first, then every ledger type by the name an admin reads, never the enum. */
const TYPE_OPTIONS: FilterOption[] = [
  { value: "", label: "All types" },
  ...TYPES.map((t) => ({ value: t, label: LEDGER_TYPE_LABEL[t] ?? t })),
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
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [readAt, setReadAt] = useState<number | null>(null);

  const from = params.get("from") ?? isoDate(daysAgo(DEFAULT_FROM_DAYS));
  const to = params.get("to") ?? isoDate(daysAgo(-1));
  const type = params.get("type") ?? "";
  const userQuery = params.get("q") ?? "";
  const userId = params.get("userId") ?? "";

  const setFilter = (key: string, value: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      // An empty date input means UNBOUNDED and an empty select means "all types"; both are
      // states worth being able to share, so they are written as an empty value rather than
      // dropped, which would read back as "unset" and silently restore the default window.
      if (value === "" && (key === "type" || key === "q" || key === "userId")) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };

  // Pin the window the admin is actually looking at into the URL, once, so the link they
  // copy means the same thing tomorrow.
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

  const load = async () => {
    setLoading(true);
    try {
      const r = await endpoints.adminLedger({
        // An empty date input means UNBOUNDED, not the malformed "T00:00:00Z" this used
        // to send. That produced a 400, a "Couldn't load ledger." toast, and the table and
        // all four totals left showing the PREVIOUS result — so a cleared filter looked
        // like one that had applied and found the same 52 rows.
        from: from ? `${from}T00:00:00Z` : undefined,
        to: to ? `${to}T23:59:59Z` : undefined,
        type: type || undefined,
        userId: userId || undefined,
        limit: 1000,
      });
      setRows(r);
      setLoadError(null);
      setReadAt(Date.now());
    } catch (e) {
      // And the stale rows go with it. Showing the last successful answer under a failed
      // filter is worse than showing nothing, because nothing on screen says it is stale.
      // The failure is ON the page, with a retry, where the table was: a toast floats away,
      // and an empty table under a failed read reads "no movements" (R12).
      setRows(null);
      setLoadError(e);
    }
    finally { setLoading(false); }
  };

  // Auto-apply filters: debounce server reload as the user edits date/type.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; load(); return; }
    const h = window.setTimeout(load, 300);
    return () => window.clearTimeout(h);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [from, to, type, userId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = userQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.subjectName.toLowerCase().includes(q) ||
      r.actorName.toLowerCase().includes(q) ||
      r.from.toLowerCase().includes(q) ||
      r.to.toLowerCase().includes(q));
  }, [rows, userQuery]);

  const totals = useMemo(() => {
    const credits = filtered.filter((r) => r.signedAmountCredits > 0).reduce((s, r) => s + r.amountCredits, 0);
    const debits = filtered.filter((r) => r.signedAmountCredits < 0).reduce((s, r) => s + r.amountCredits, 0);
    return { credits, debits, net: credits - debits, count: filtered.length };
  }, [filtered]);

  return (
    <PageShell width="wide">
      <PageHeader
        title="Transactions"
        description="Every credit movement across the club — top-ups, charges, refunds, penalties and manual adjustments."
        actions={<RefreshButton onRefresh={() => void load()} loading={loading} />}
        freshness={<Freshness at={readAt} />}
      />

      <div className="flex flex-col gap-3">
        <FilterBar>
          <FilterDate label="From" value={from} onChange={(next) => setFilter("from", next)} />
          <FilterDate label="To" value={to} onChange={(next) => setFilter("to", next)} />
          <FilterSelect
            id="ledger-type"
            label="Type"
            value={type}
            options={TYPE_OPTIONS}
            onChange={(next) => setFilter("type", next)}
          />
          <Field controlId="ledger-search" className="min-w-48 flex-[2_1_14rem]">
            <FieldLabel>Search (name)</FieldLabel>
            <div className="relative">
              <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <Input
                className="pl-9"
                placeholder="Member or admin name"
                value={userQuery}
                onChange={(e) => setFilter("q", e.target.value)}
              />
            </div>
          </Field>
        </FilterBar>

        {userId && (
          // `?userId=` is answered by the API and had no way in from the screen, so a link to
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
        action="those movements"
        failedCaveat="Check the dates and try again."
        onRetry={() => void load()}
        skeleton={<TableSkeleton rows={6} />}
      >
        <Card className="gap-0 pb-0 sm:gap-0 sm:pb-0" aria-busy={loading || undefined}>
          <CardContent className="grid shrink-0 grid-cols-2 gap-3 pb-4 text-sm sm:grid-cols-4">
            {/*
              Every signed figure through `formatSignedCredits`, never a sign composed around
              `formatCredits`.

              These two read `+${formatCredits(...)}` and `−${formatCredits(...)}`, so the sign
              was decided by which tile it was rather than by the figure in it, and a filter
              that matched nothing rendered "+0.00 cr" beside "−0.00 cr" on the one screen whose
              whole job is reconciling money. A signed zero reads as a movement that did not
              happen. `formatSignedCredits` already answers this — its own comment records the
              reports card that made the identical mistake and was brought through it — and its
              zero arm is why the fix is here at the formatter boundary rather than in a guard on
              the empty case: a genuine zero-valued adjustment row is wrong in exactly the same
              way, with a table full of rows underneath it.

              Debits are summed as a MAGNITUDE (`amountCredits` of the rows whose signed amount
              is negative), so the negation is what tells the formatter which direction this tile
              is counting. The sign on screen is then the sign of a number, which is the property
              that cannot drift.
            */}
            <Stat label="Movements" value={String(totals.count)} />
            <Stat label="Credits" value={formatSignedCredits(totals.credits)} tone={toneOf(totals.credits)} />
            <Stat label="Debits" value={formatSignedCredits(-totals.debits)} tone={toneOf(-totals.debits)} />
            <Stat label="Net" value={formatSignedCredits(totals.net)} tone={toneOf(totals.net)} />
          </CardContent>
          <LedgerTable rows={filtered} emptyText="No movements match these filters." label="Club ledger" />
        </Card>
      </StateBlock>
    </PageShell>
  );
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

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-success-strong" : tone === "warning" ? "text-warning-strong" : "text-text-primary";
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-overline text-text-secondary">{label}</p>
      <p data-ledger-total="" className={`text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
