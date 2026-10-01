import { useCallback, useEffect, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Plus, Racquet } from "../../components/ui/icons";
import { AutoGrid } from "../../components/ui/auto-grid";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { RefreshButton } from "../../components/ui/refresh-button";
import { Skeleton } from "../../components/ui/skeleton";
import { StateBlock } from "../../components/ui/state-block";
import { CourtSheet } from "../../components/settings/CourtSheet";
import { endpoints, type AdminCourt } from "../../lib/api";
import { COURTS_COPY } from "../../lib/courtsCopy";

/**
 * Admin · Courts (`/admin/courts`) — the club's courts, their prices, and whether each is in use.
 *
 * <p>
 * <b>Moved out of Settings</b> (plan P6). A court is a record with a lifecycle — added, priced,
 * taken out of use, put back — not a club-wide number, and it used to share one Save button with
 * the door policy. Here each court is a row that reads, and one press opens it in a sheet.
 * </p>
 *
 * <p>
 * <b>No reordering.</b> Courts are listed by their number, which the API assigns on creation and
 * offers no way to change; a drag handle that could not be saved would be a control that lies.
 * </p>
 *
 * <p>
 * <b>A failed read is not "no courts".</b> The list starts as null, not `[]`: a club whose read
 * failed is shown the failure and a retry, never the empty state that would invite an admin to
 * add a court the club already has.
 * </p>
 */
export default function AdminCourtsPage() {
  const [courts, setCourts] = useState<AdminCourt[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AdminCourt | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCourts(await endpoints.adminCourtsList());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  const add = () => setEditing("new");

  return (
    <PageShell width="full">
      <PageHeader
        title={COURTS_COPY.title}
        description={COURTS_COPY.description}
        actions={(
          <>
            <RefreshButton label={COURTS_COPY.refresh} loading={loading} onRefresh={() => void load()} />
            <Button onClick={add} icon={<Plus aria-hidden="true" />}>{COURTS_COPY.add}</Button>
          </>
        )}
      />
      <StateBlock
        loading={loading && courts === null}
        error={error}
        action={COURTS_COPY.readAction}
        failedCaveat={COURTS_COPY.readCaveat}
        onRetry={() => void load()}
        empty={courts !== null && courts.length === 0}
        emptyTitle={COURTS_COPY.emptyTitle}
        emptyHint={COURTS_COPY.emptyHint}
        emptyIcon={Racquet}
        emptyAction={<Button onClick={add} icon={<Plus aria-hidden="true" />}>{COURTS_COPY.add}</Button>}
        skeleton={<CourtListSkeleton />}
      >
        {courts ? <CourtList courts={courts} onEdit={setEditing} /> : null}
      </StateBlock>
      <CourtSheet
        court={editing}
        suggestedPrice={usualPrice(courts)}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
    </PageShell>
  );
}

/** The price most of the club's courts in use charge — where a new court's price starts. */
function usualPrice(courts: AdminCourt[] | null): number | null {
  const prices = (courts ?? []).filter((court) => court.is_active).map((court) => court.slice_price_credits);
  if (prices.length === 0) return null;
  const counts = new Map<number, number>();
  for (const price of prices) counts.set(price, (counts.get(price) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function CourtListSkeleton() {
  return (
    <AutoGrid min="card" max={4} gap="lg" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3 rounded-xl border border-border bg-bg-surface p-4">
          <Skeleton className="size-11 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-9 w-16" />
        </div>
      ))}
    </AutoGrid>
  );
}

/**
 * The courts as cards (R4 form factor, SPEC §3.16): a 4-row list floated in 58 % of a 1920
 * screen. Each court is a card — its number, name, rate, whether it is in use, Edit — packed as
 * many across as the box holds (AutoGrid card, at most 4), one across on a phone.
 */
function CourtList({ courts, onEdit }: { courts: AdminCourt[]; onEdit: (court: AdminCourt) => void }) {
  const inUse = courts.filter((court) => court.is_active).length;
  return (
    <section aria-labelledby="courts-list-title" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="courts-list-title" className="text-sm font-semibold text-text-primary">{COURTS_COPY.listLabel}</h2>
        <p className="text-sm tabular-nums text-text-secondary">{COURTS_COPY.count(inUse, courts.length)}</p>
      </div>
      <AutoGrid as="ul" min="card" max={4} gap="lg">
        {courts.map((court) => <CourtRow key={court.id} court={court} onEdit={() => onEdit(court)} />)}
      </AutoGrid>
    </section>
  );
}

function CourtRow({ court, onEdit }: { court: AdminCourt; onEdit: () => void }) {
  return (
    // Wraps (R3 X-4): at 200% text the badge and Edit went past a phone's edge; now they drop
    // under the name instead.
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-surface p-4 shadow-xs">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-bg-muted font-display text-lg font-bold tabular-nums text-text-primary">
        <span aria-hidden="true">{court.court_number}</span>
        <span className="sr-only">{COURTS_COPY.number(court.court_number)}</span>
      </span>
      <div className="min-w-0 flex-1 basis-20">
        <p className="truncate text-sm font-semibold text-text-primary" title={court.name}>{court.name}</p>
        <p className="text-sm tabular-nums text-text-secondary">
          {COURTS_COPY.price(court.slice_price_credits)}
          <span> · {court.court_type}</span>
        </p>
      </div>
      <div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <Badge tone={court.is_active ? "success" : "neutral"} className="whitespace-nowrap">{court.is_active ? COURTS_COPY.inUse : COURTS_COPY.notInUse}</Badge>
        <Button variant="outline" size="sm" aria-label={COURTS_COPY.editLabel(court.name)} onClick={onEdit}>
          {COURTS_COPY.edit}
        </Button>
      </div>
    </li>
  );
}
