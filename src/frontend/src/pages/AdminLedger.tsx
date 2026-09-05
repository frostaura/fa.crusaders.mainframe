import { useEffect, useMemo, useRef, useState } from "react";
import { endpoints, LEDGER_ENTRY_TYPES, type LedgerRow } from "../lib/api";
import { formatCredits, formatSignedCredits } from "../lib/utils";
import { Card } from "../components/Card";
import { Input, Label } from "../components/Button";
import { LedgerTable } from "../components/LedgerTable";
import { useToast } from "../components/Toast";

// Derived from the union in api.ts rather than hand-maintained here. This was a
// literal array with no connection to the type, so a ledger type added on the
// backend became unfilterable with nothing to warn anyone.
const TYPES = LEDGER_ENTRY_TYPES;

export default function AdminLedgerPage() {
  const toast = useToast();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(() => isoDate(daysAgo(30)));
  const [to, setTo] = useState(() => isoDate(daysAgo(-1)));
  const [type, setType] = useState("");
  const [userQuery, setUserQuery] = useState("");

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
  }, [from, to, type]);

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
            <Label>From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label>Type</Label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full h-11 px-3 rounded-lg border border-border bg-bg-surface text-text-primary"
            >
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div>
          <Label>Search (name)</Label>
          <Input placeholder="Filter by member or admin name…" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} />
          {loading && <p className="text-xs text-text-muted mt-1">Refreshing…</p>}
        </div>
      </Card>

      <Card className="!p-0 flex flex-col flex-1 min-h-0">
        <div className="px-4 sm:px-6 pt-4 pb-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm shrink-0">
          <Stat label="Movements" value={String(totals.count)} />
          <Stat label="Credits" value={`+${formatCredits(totals.credits)}`} tone="success" />
          <Stat label="Debits" value={`−${formatCredits(totals.debits)}`} tone="warning" />
          <Stat label="Net" value={formatSignedCredits(totals.net)} tone={totals.net >= 0 ? "success" : "warning"} />
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
