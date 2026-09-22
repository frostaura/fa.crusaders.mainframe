import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { endpoints, LEDGER_ENTRY_TYPES, type LedgerRow } from "../lib/api";
import { formatMoney, formatSignedMoney } from "../lib/utils";
import { Card } from "../components/Card";
import { Button, Input, Label, fieldClassName } from "../components/Button";
import { LedgerTable } from "../components/LedgerTable";
import { useToast } from "../components/Toast";

// Derived from the union in api.ts rather than hand-maintained here. This was a
// literal array with no connection to the type, so a ledger type added on the
// backend became unfilterable with nothing to warn anyone.
const TYPES = LEDGER_ENTRY_TYPES;

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
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(false);

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
    } catch {
      // And the stale rows go with it. Showing the last successful answer under a failed
      // filter is worse than showing nothing, because nothing on screen says it is stale.
      setRows(null);
      toast.push({ tone: "danger", text: "Couldn't load those movements — check the dates and try again." });
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
    <div className="flex-1 min-h-0 flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Transactions</h1>
        <p className="text-sm text-text-secondary">Every credit movement across the tenant — top-ups, charges, refunds, penalties, manual adjustments.</p>
      </div>

      <Card className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <Label htmlFor="ledger-from">From</Label>
            <Input id="ledger-from" type="date" value={from} onChange={(e) => setFilter("from", e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ledger-to">To</Label>
            <Input id="ledger-to" type="date" value={to} onChange={(e) => setFilter("to", e.target.value)} />
          </div>
          <div>
            <Label htmlFor="ledger-type">Type</Label>
            <select
              id="ledger-type"
              value={type}
              onChange={(e) => setFilter("type", e.target.value)}
              className={fieldClassName}
            >
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div>
          <Label htmlFor="ledger-search">Search (name)</Label>
          <Input id="ledger-search" placeholder="Filter by member or admin name…" value={userQuery} onChange={(e) => setFilter("q", e.target.value)} />
          {loading && <p className="text-xs text-text-muted mt-1">Refreshing…</p>}
        </div>

        {userId && (
          // `?userId=` is answered by the API and had no way in from the screen, so a link to
          // one member's movements silently showed the whole club's. It is honoured now, and
          // said out loud — an unexplained short list is the same defect wearing a filter.
          <div className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-info-soft text-info-strong font-medium">
              Showing one member’s movements
            </span>
            <Button variant="ghost" type="button" className="h-8 px-2 text-xs" onClick={() => setFilter("userId", "")}>
              Show everyone
            </Button>
          </div>
        )}
      </Card>

      <Card className="!p-0 flex flex-col flex-1 min-h-0">
        <div className="px-4 sm:px-6 pt-4 pb-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm shrink-0">
          <Stat label="Movements" value={String(totals.count)} />
          <Stat label="Credits" value={`+${formatMoney(totals.credits)}`} tone="success" />
          <Stat label="Debits" value={`−${formatMoney(totals.debits)}`} tone="warning" />
          <Stat label="Net" value={formatSignedMoney(totals.net)} tone={totals.net >= 0 ? "success" : "warning"} />
        </div>
        <LedgerTable rows={filtered} emptyText={loading ? "Loading…" : "No movements match these filters."} fill label="Club ledger" />
      </Card>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "success" | "warning" }) {
  const toneClass = tone === "success" ? "text-success-strong" : tone === "warning" ? "text-warning-strong" : "text-text-primary";
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`font-mono text-base ${toneClass}`}>{value}</p>
    </div>
  );
}

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d; }
