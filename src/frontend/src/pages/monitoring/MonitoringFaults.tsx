import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "../../components/Alert";
import { ConfirmDialog } from "../../components/admin/ConfirmDialog";
import { useToast } from "../../components/Toast";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { PageHeader, PageShell } from "../../components/ui/page-shell";
import { Freshness, RefreshButton } from "../../components/ui/refresh-button";
import { StateBlock } from "../../components/ui/state-block";
import { Check, CheckCircle, X } from "../../components/ui/icons";
import {
  CardListSkeleton, DownloadCsvLink, FilterBar, FilterSelect, type FilterOption,
} from "../../components/monitoring/parts";
import { useAsyncAction } from "../../lib/useAsyncAction";
import { useTicker } from "../../lib/useTicker";
import { cn } from "../../lib/utils";
import { clubDayAndClock, clubRowTime } from "../../lib/clubClock";
import { relative } from "../../lib/deviceLiveness";
import { ApiError } from "../../lib/api";
import {
  DEVICE_ERROR_SEVERITIES, adminEndpoints,
  type DeviceErrorPage, type DeviceErrorRow, type DeviceErrorSeverity, type DeviceErrorState,
} from "../../lib/adminApi";
import {
  FAULTS_READ_FAILED, RESOLVE_MEANING, SEVERITY_TONE, SEVERITY_WORD, boardLabel, explainFault,
  faultDetail, faultsEmptyNotice, occurrenceLine, resolveConfirm, resolvedLine,
} from "../../lib/deviceFaultCopy";

/**
 * Faults — GOAL item 7. `/admin/monitoring/faults`.
 *
 * <p>
 * <b>Why this page did not exist.</b> Device <i>outages</i> were recorded and device
 * <i>events</i> were receipted, but a board reporting a scanner fault, a relay refusal or an
 * LCD failure had nowhere to put it: the heartbeat's two diagnostic counters were
 * <code>LogWarning</code>ed and discarded by an explicit decision whose stated reason was that
 * nothing decided anything on them. This page is the something.
 * </p>
 *
 * <p>
 * <b>Grouped by board, then by fault, because an admin walks to a board and not to an error
 * code.</b> The shape of the page is the shape of the trip somebody makes with it.
 * </p>
 *
 * <p>
 * <b>Resolve is the only verb, and the page says what it is.</b> D3 designed an
 * Acknowledge / Mark-resolved pair where acknowledge silenced a badge for two hours; D2's wire
 * has one endpoint, <code>POST /monitoring/errors/{id}/resolve {note}</code>, and no
 * server-side guard on resolving a fault that is still happening. Rather than invent an
 * endpoint, the page is honest about the verb it has — see {@link RESOLVE_MEANING} — because
 * a control that quietly means something different from its word is how an admin comes to
 * believe a board is fixed.
 * </p>
 */

const REFRESH_MS = 15_000;

/** The filters this page actually offers. A range picker is the door log's and is not rebuilt here. */
type Filters = { state: DeviceErrorState; severity: DeviceErrorSeverity | ""; device: string };

/** One board's worth of faults, which is the unit an admin acts on. */
type Board = { key: string; name: string; rows: DeviceErrorRow[] };

/**
 * Group by board, newest-seen board first.
 *
 * <p>
 * A row with no `device_id` is real and must not be dropped: an authentication failure has no
 * device row by definition, and it is exactly the fault an admin most needs to see. It gets
 * its own group named for what it is rather than being hidden under a board that did not
 * report it.
 * </p>
 */
export function groupByBoard(rows: DeviceErrorRow[]): Board[] {
  const byKey = new Map<string, Board>();
  for (const row of rows) {
    const key = row.device_id ?? "__no_board__";
    /*
      A row with no `device_id` is NOT named after the code the caller claimed. An
      authentication failure carries `claimed_device_code`, which is a string an
      unauthenticated caller chose — filing it under "CB-01" would put an intruder's rows
      inside the club's own board, which is the one place an admin would never look for them.
    */
    const name = row.device_id
      ? boardLabel(row)
      : "Not from a board the club knows";
    const board = byKey.get(key) ?? { key, name, rows: [] };
    board.rows.push(row);
    byKey.set(key, board);
  }
  return [...byKey.values()].sort((a, b) => {
    const latest = (board: Board) => Math.max(...board.rows.map((r) => Date.parse(r.last_seen_at) || 0));
    return latest(b) - latest(a);
  });
}

/**
 * The fault list's read: the filters, the rows, and the fifteen-second poll while the tab is in
 * front. Its own hook so the page is a layout and not also a loader.
 */
function useFaultList() {
  const [page, setPage] = useState<DeviceErrorPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [filters, setFilters] = useState<Filters>({ state: "open", severity: "", device: "" });
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async (f: Filters) => {
    try {
      const next = await adminEndpoints.monitoringErrors(filterQuery(f));
      setPage(next);
      setError(null);
      setCheckedAt(Date.now());
    } catch (err) {
      // The rows are NOT cleared. A failed re-read is a fact about the request and the rows
      // on screen are still the last thing the club actually said; what would be dishonest
      // is showing them with no qualifier, which the band on the page prevents.
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // `load` is async; the only synchronous thing here is starting a request, and every
  // setState inside it runs in a promise callback. Re-reading when the filters change is what
  // this effect is FOR.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
  useEffect(() => { void load(filters); }, [load, filters]);

  // The doors idiom, verbatim: 15 seconds while the tab is in front, and the header says so.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void load(filters);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, filters]);

  const reload = useCallback(() => load(filters), [load, filters]);
  return { page, loading, error, filters, setFilters, checkedAt, reload };
}

/** The query a set of filters asks — "" means "anything" and is left off, never sent empty. */
function filterQuery(f: Filters) {
  return {
    state: f.state,
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.device ? { device: f.device } : {}),
  };
}

type BatchLine = { id: string; ok: boolean; said: string };

/** What one item of a batch resolve came back as, in words. */
function batchLine(r: { id: string; status: string; error?: string | null }): BatchLine {
  return {
    id: r.id,
    ok: r.status === "resolved",
    said: r.status === "already_resolved"
      ? "Somebody else marked this one resolved while you were deciding."
      : r.error ?? (r.status === "resolved" ? "Marked resolved." : r.status),
  };
}

/**
 * Selecting and resolving. Partial by nature — a fault somebody else resolved while this admin
 * was deciding comes back `already_resolved`, which is a per-item outcome and not a failure of
 * the batch.
 */
function useFaultResolve(reload: () => Promise<void>) {
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<BatchLine[] | null>(null);

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const resolve = async (ids: string[], note: string) => {
    try {
      if (ids.length === 1) {
        await adminEndpoints.resolveError(ids[0], note);
        toast.push({ tone: "success", text: "Marked resolved." });
      } else {
        const result = await adminEndpoints.resolveErrors(ids, note);
        // Never a toast for a batch: four seconds is not long enough to read six outcomes,
        // and the toast viewport deliberately carries no live region of its own.
        setBatch(result.results.map(batchLine));
      }
      setSelected(new Set());
      await reload();
      return "Marked resolved.";
    } catch (err) {
      // `unchanged` only where it is KNOWN. A 4xx is the server refusing before it wrote; a
      // network failure may have been applied and the answer lost on the way back, and
      // claiming otherwise is the one thing worse than saying nothing.
      const refused = err instanceof ApiError && err.status >= 400 && err.status < 500;
      toast.push({
        tone: "danger",
        text: refused ? "The club refused that." : "Couldn't reach the club.",
        unchanged: refused,
        durationMs: 8000,
      });
      return "That didn't work.";
    }
  };

  return { selected, toggle, clear: () => setSelected(new Set()), batch, closeBatch: () => setBatch(null), resolve };
}

export function MonitoringFaultsPage() {
  const { page, loading, error, filters, setFilters, checkedAt, reload } = useFaultList();
  const { selected, toggle, clear, batch, closeBatch, resolve } = useFaultResolve(reload);
  const now = useTicker(true);
  // A press shows its own pending state; the fifteen-second poll behind it never does.
  const manual = useAsyncAction(reload);

  const rows = useMemo(() => page?.rows ?? [], [page]);
  const boards = useMemo(() => groupByBoard(rows), [rows]);
  const timezone = page?.timezone;
  const selectedIds = [...selected].filter((id) => rows.some((r) => r.id === id));
  const boardCount = boards.filter((b) => b.key !== "__no_board__").length;

  return (
    <PageShell width="wide">
      <PageHeader
        title="Faults"
        description={`What the club's boards have reported going wrong, grouped by board. Re-reads every ${REFRESH_MS / 1000} seconds while this tab is in front.`}
        actions={<RefreshButton onRefresh={() => void manual.run()} loading={manual.pending} />}
        freshness={<Freshness at={checkedAt} />}
      />

      {/* Standing, not polite: this page re-reads itself every fifteen seconds, and a polite
          region announces the same paragraph on every remount. */}
      <Alert tone="info" live="standing" announceKey="faults-what-resolve-means">
        {RESOLVE_MEANING}
      </Alert>

      <FaultFilters filters={filters} onFilters={setFilters} boards={boards} />

      {selectedIds.length > 0 && (
        <SelectionStrip ids={selectedIds} onClear={clear} onResolve={() => resolve(selectedIds, "")} />
      )}

      {batch && <BatchOutcome batch={batch} onDone={closeBatch} />}

      {/* A failed RE-read with rows in hand: the rows stay, the band says they are not being
          updated. A failed FIRST read has nothing to qualify and goes to StateBlock below. */}
      {error !== null && error !== undefined && rows.length > 0 && (
        <Alert tone="danger" live="standing" announceKey="faults-unreachable">{FAULTS_READ_FAILED}</Alert>
      )}

      <FaultBoards
        read={{ loading, error, rows, boards, boardCount, retentionDays: page?.retention_days ?? null }}
        showingOpen={filters.state === "open"}
        clock={{ now, timezone }}
        selection={{ selected, toggle, resolve }}
        onRetry={() => void manual.run()}
      />

      <RetentionNote retentionDays={page?.retention_days ?? null} checkedAt={checkedAt} now={now} timezone={timezone} />
    </PageShell>
  );
}

type FaultBoardsProps = {
  read: {
    loading: boolean;
    error: unknown;
    rows: DeviceErrorRow[];
    boards: Board[];
    boardCount: number;
    retentionDays: number | null;
  };
  /** The "Still open" filter is on — the empty state then points at "Marked resolved". */
  showingOpen: boolean;
  clock: { now: number; timezone: string | undefined };
  selection: {
    selected: Set<string>;
    toggle: (id: string) => void;
    resolve: (ids: string[], note: string) => Promise<string>;
  };
  onRetry: () => void;
};

/**
 * The list itself — failed, loading, empty, or one card per board. Failed only when there is
 * nothing to fall back on: rows the club already gave us stay, under the page's band.
 */
function FaultBoards(props: FaultBoardsProps) {
  // Destructured in the body: lizard counts every destructured name as a parameter (gate: 6).
  const { read, showingOpen, clock, selection, onRetry } = props;
  return (
    <StateBlock
      loading={read.loading}
      error={read.rows.length > 0 ? null : read.error}
      action="read the fault list"
      failedCaveat="That does not mean there are none."
      onRetry={onRetry}
      empty={!read.loading && !read.error && read.rows.length === 0}
      emptyIcon={CheckCircle}
      emptyTitle={faultsEmptyNotice(read.boardCount || null, read.retentionDays)}
      emptyHint={showingOpen
        ? "Anything a board has reported and somebody has since marked resolved is under “Marked resolved”."
        : undefined}
      skeleton={<CardListSkeleton rows={2} />}
    >
      <div className="flex flex-col gap-4">
        {read.boards.map((board) => (
          <Card key={board.key}>
            <CardHeader>
              <CardTitle asChild><h2>{board.name}</h2></CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-4">
                {board.rows.map((row) => (
                  <FaultRow
                    key={row.id}
                    row={row}
                    now={clock.now}
                    timezone={clock.timezone}
                    selected={selection.selected.has(row.id)}
                    onToggle={() => selection.toggle(row.id)}
                    onResolve={(note) => selection.resolve([row.id], note)}
                  />
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </StateBlock>
  );
}

/** Show / How bad / Board, and the export of exactly what they select. */
function FaultFilters({ filters, onFilters, boards }: {
  filters: Filters;
  onFilters: (update: (f: Filters) => Filters) => void;
  boards: Board[];
}) {
  return (
    <FilterBar>
      <FilterSelect
        id="fault-state"
        label="Show"
        value={filters.state}
        options={STATE_OPTIONS}
        onChange={(next) => onFilters((f) => ({ ...f, state: next as DeviceErrorState }))}
      />
      <FilterSelect
        id="fault-severity"
        label="How bad"
        value={filters.severity}
        options={SEVERITY_OPTIONS}
        onChange={(next) => onFilters((f) => ({ ...f, severity: next as DeviceErrorSeverity | "" }))}
      />
      <FilterSelect
        id="fault-device"
        label="Board"
        value={filters.device}
        options={[
          { value: "", label: "Every board" },
          ...boards.filter((b) => b.key !== "__no_board__").map((b) => ({ value: b.key, label: b.name })),
        ]}
        onChange={(next) => onFilters((f) => ({ ...f, device: next }))}
      />
      <DownloadCsvLink className="sm:ml-auto" href={adminEndpoints.monitoringErrorsCsvUrl(filterQuery(filters))} />
    </FilterBar>
  );
}

/** The consequence, without the question the dialog's title now asks. */
function resolveBody(count: number): string {
  return resolveConfirm(count).replace(/^[^?]*\? /, "");
}

/**
 * The selection strip. It is not a toast and it is not a modal: the rows stay on screen,
 * because the decision an admin is making is about the rows.
 */
function SelectionStrip({ ids, onClear, onResolve }: {
  ids: string[];
  onClear: () => void;
  onResolve: () => Promise<string>;
}) {
  const one = ids.length === 1;
  return (
    <div
      role="region"
      aria-label="Selected faults"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-accent-strong bg-accent-soft p-4"
    >
      <p className="mr-auto text-sm font-semibold text-text-primary">
        {one ? "1 fault selected" : `${ids.length} faults selected`}
      </p>
      <Button variant="ghost" onClick={onClear}>Clear</Button>
      <ConfirmDialog
        trigger={<Button icon={<Check aria-hidden="true" />}>{one ? "Mark it resolved" : `Mark ${ids.length} resolved`}</Button>}
        tone="primary"
        title={one ? "Mark this fault resolved?" : `Mark these ${ids.length} faults resolved?`}
        description={resolveBody(ids.length)}
        confirmLabel={one ? "Mark it resolved" : `Mark all ${ids.length} resolved`}
        cancelLabel={one ? "Leave it open" : "Leave them open"}
        onConfirm={onResolve}
      />
    </div>
  );
}

/** How long faults are kept, and when this list was read — in the club's clock. */
function RetentionNote({ retentionDays, checkedAt, now, timezone }: {
  retentionDays: number | null;
  checkedAt: number | null;
  now: number;
  timezone: string | undefined;
}) {
  const checkedFace = checkedAt === null ? null : clubRowTime(checkedAt, now, timezone);
  return (
    <p className="text-xs text-text-muted">
      {retentionDays
        ? `Faults are kept for ${retentionDays} days. One that stops being reported is closed by itself and kept, rather than deleted, so the club's count stays honest.`
        : "Faults are kept for as long as the club's settings say."}
      {checkedFace ? ` Read at ${checkedFace} club time.` : ""}
    </p>
  );
}

const STATE_OPTIONS: FilterOption[] = [
  { value: "open", label: "Still open" },
  { value: "resolved", label: "Marked resolved" },
  { value: "all", label: "Everything" },
];

const SEVERITY_OPTIONS: FilterOption[] = [
  { value: "", label: "Anything" },
  ...DEVICE_ERROR_SEVERITIES.map((s) => ({ value: s, label: SEVERITY_WORD[s] })),
];

/**
 * What a batch resolve did, item by item. Never a toast: four seconds is not long enough to read
 * six outcomes, and the toast viewport deliberately carries no live region of its own. Each line
 * says ok or not in WORDS as well as the icon, because colour and a glyph are never alone.
 */
function BatchOutcome({ batch, onDone }: {
  batch: Array<{ id: string; ok: boolean; said: string }>;
  onDone: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2 aria-live="polite">{`${batch.filter((b) => b.ok).length} of ${batch.length} done.`}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2 text-sm">
          {batch.map((b) => (
            <li key={b.id} className={cn("flex items-start gap-2", b.ok ? "text-text-secondary" : "text-danger-strong")}>
              {b.ok
                ? <Check size={16} weight="bold" aria-label="Done:" className="mt-0.5 shrink-0 text-success-strong" />
                : <X size={16} weight="bold" aria-label="Not done:" className="mt-0.5 shrink-0" />}
              <span>{b.said}</span>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={onDone}>Done</Button>
      </CardFooter>
    </Card>
  );
}

/**
 * One fault, with everything an admin needs to decide whether to walk to the board.
 *
 * The severity chip carries the WORD as well as the tone, and the icon is text rather than an
 * image: under forced colours a coloured pill is a grey pill, and this is the only thing left.
 */
function FaultRow({ row, now, timezone, selected, onToggle, onResolve }: {
  row: DeviceErrorRow;
  now: number;
  timezone: string | undefined;
  selected: boolean;
  onToggle: () => void;
  onResolve: (note: string) => void | string | Promise<void | string>;
}) {
  const said = explainFault(row, timezone);
  const tone = SEVERITY_TONE[row.severity] ?? "info";
  const resolved = Boolean(row.resolved_at);

  return (
    <li className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {!resolved && (
          // The checkbox's own after: box extends its hit area to 44px; the span holds the row.
          <span className="inline-flex size-touch shrink-0 items-center justify-center">
            <Checkbox
              checked={selected}
              onCheckedChange={onToggle}
              aria-label={`Select ${said.title}`}
            />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone={tone}>{SEVERITY_WORD[row.severity]}</Badge>
            <p className="min-w-0 break-words font-medium text-text-primary">{said.title}</p>
            {/* The raw code stays reachable for whoever has to report it upstream. Losing it
                would make a humanised unknown unsearchable. */}
            {said.unrecognised && (
              <code className="rounded-sm bg-bg-muted px-1.5 py-0.5 font-mono text-xs text-text-muted">{row.code}</code>
            )}
          </div>
          <p className="text-xs text-text-muted">
            {occurrenceLine(
              row.count,
              clubDayAndClock(row.first_seen_at, timezone),
              relative(row.last_seen_at, now),
            )}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-text-muted">What it means</dt>
            <dd className="min-w-0 break-words text-text-secondary">{said.means}</dd>
            <dt className="text-text-muted">What to do</dt>
            <dd className="min-w-0 break-words text-text-secondary">{said.doThis}</dd>
          </dl>
          {row.detail && !said.unrecognised && said.means !== faultDetail(row.detail, timezone) && (
            <p className="min-w-0 break-words text-xs text-text-muted">{faultDetail(row.detail, timezone)}</p>
          )}
          {resolved && (
            <p className="text-sm text-success-strong">
              {resolvedLine(
                row.resolved_by_name ?? null,
                clubDayAndClock(row.resolved_at!, timezone),
                row.resolution_note ?? null,
              )}
            </p>
          )}
        </div>
        {!resolved && (
          <ConfirmDialog
            trigger={(
              <Button variant="outline" size="sm" className="shrink-0">
                Mark resolved{" "}<span className="sr-only">{`— ${said.title}`}</span>
              </Button>
            )}
            tone="primary"
            title={`Mark “${said.title}” resolved?`}
            description={resolveBody(1)}
            confirmLabel="Mark resolved"
            cancelLabel="Leave it open"
            onConfirm={() => onResolve("")}
          />
        )}
      </div>
    </li>
  );
}
