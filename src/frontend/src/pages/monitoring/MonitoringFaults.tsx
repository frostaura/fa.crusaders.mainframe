import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "../../components/Alert";
import { Badge, Button, Label, Select } from "../../components/Button";
import { Card } from "../../components/Card";
import { ConfirmButton } from "../../components/ConfirmButton";
import { StateBlock } from "../../components/StateBlock";
import { MonitoringNav } from "../../components/monitoring/MonitoringNav";
import { useToast } from "../../components/Toast";
import { useTicker } from "../../lib/useTicker";
import { clubDayAndClock, clubRowTime } from "../../lib/clubClock";
import { relative } from "../../lib/deviceLiveness";
import { ApiError } from "../../lib/api";
import {
  DEVICE_ERROR_SEVERITIES, adminEndpoints,
  type DeviceErrorPage, type DeviceErrorRow, type DeviceErrorSeverity, type DeviceErrorState,
} from "../../lib/adminApi";
import {
  FAULTS_READ_FAILED, RESOLVE_MEANING, SEVERITY_TONE, SEVERITY_WORD, explainFault,
  faultsEmptyNotice, occurrenceLine, resolveConfirm, resolvedLine,
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
      ? (row.device_name ?? row.device_code ?? "Unnamed board")
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

export function MonitoringFaultsPage() {
  const toast = useToast();
  const [page, setPage] = useState<DeviceErrorPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [filters, setFilters] = useState<Filters>({ state: "open", severity: "", device: "" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const now = useTicker(true);

  const load = useCallback(async (f: Filters) => {
    try {
      const next = await adminEndpoints.monitoringErrors({
        state: f.state,
        ...(f.severity ? { severity: f.severity } : {}),
        ...(f.device ? { device: f.device } : {}),
      });
      setPage(next);
      setError(null);
      setCheckedAt(Date.now());
    } catch (err) {
      // The rows are NOT cleared. A failed re-read is a fact about the request and the rows
      // on screen are still the last thing the club actually said; what would be dishonest
      // is showing them with no qualifier, which the band below prevents.
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

  const rows = page?.rows ?? [];
  const boards = useMemo(() => groupByBoard(rows), [rows]);
  const timezone = page?.timezone;
  const selectedIds = [...selected].filter((id) => rows.some((r) => r.id === id));

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /**
   * Resolve one or several. Partial by nature — a fault somebody else resolved while this
   * admin was deciding comes back `already_resolved`, which is a per-item outcome and not a
   * failure of the batch.
   */
  const resolve = async (ids: string[], note: string) => {
    try {
      if (ids.length === 1) {
        await adminEndpoints.resolveError(ids[0], note);
        toast.push({ tone: "success", text: "Marked resolved." });
      } else {
        const result = await adminEndpoints.resolveErrors(ids, note);
        // Never a toast for a batch: four seconds is not long enough to read six outcomes,
        // and the toast viewport deliberately carries no live region of its own.
        setBatch(result.results.map((r) => ({
          id: r.id,
          ok: r.status === "resolved",
          said: r.status === "already_resolved"
            ? "Somebody else marked this one resolved while you were deciding."
            : r.error ?? (r.status === "resolved" ? "Marked resolved." : r.status),
        })));
      }
      setSelected(new Set());
      await load(filters);
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

  const [batch, setBatch] = useState<Array<{ id: string; ok: boolean; said: string }> | null>(null);

  const boardCount = boards.filter((b) => b.key !== "__no_board__").length;
  const checkedFace = checkedAt === null ? null : clubRowTime(checkedAt, now, timezone);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-bold tracking-tight">Faults</h1>
        <p className="text-xs text-text-muted">
          {checkedAt === null ? "Checking…" : `Checked ${relative(new Date(checkedAt).toISOString(), now)}`}
          {` · re-reads every ${REFRESH_MS / 1000} seconds while this tab is in front`}
        </p>
        <MonitoringNav />
      </header>

      {/* Standing, not polite: this page re-reads itself every fifteen seconds, and a polite
          region announces the same paragraph on every remount. */}
      <Alert tone="info" live="standing" announceKey="faults-what-resolve-means">
        {RESOLVE_MEANING}
      </Alert>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="fault-state">Show</Label>
            <Select
              id="fault-state"
              className="min-h-11"
              value={filters.state}
              onChange={(e) => setFilters((f) => ({ ...f, state: e.target.value as DeviceErrorState }))}
            >
              <option value="open">Still open</option>
              <option value="resolved">Marked resolved</option>
              <option value="all">Everything</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="fault-severity">How bad</Label>
            <Select
              id="fault-severity"
              className="min-h-11"
              value={filters.severity}
              onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value as DeviceErrorSeverity | "" }))}
            >
              <option value="">Anything</option>
              {DEVICE_ERROR_SEVERITIES.map((s) => (
                <option key={s} value={s}>{SEVERITY_WORD[s]}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="fault-device">Board</Label>
            <Select
              id="fault-device"
              className="min-h-11"
              value={filters.device}
              onChange={(e) => setFilters((f) => ({ ...f, device: e.target.value }))}
            >
              <option value="">Every board</option>
              {boards.filter((b) => b.key !== "__no_board__").map((b) => (
                <option key={b.key} value={b.key}>{b.name}</option>
              ))}
            </Select>
          </div>
          <a
            className="ml-auto inline-flex min-h-11 items-center rounded-lg border border-control bg-bg-surface px-4 text-sm font-medium"
            href={adminEndpoints.monitoringErrorsCsvUrl({
              state: filters.state,
              ...(filters.severity ? { severity: filters.severity } : {}),
              ...(filters.device ? { device: filters.device } : {}),
            })}
          >
            Download CSV
          </a>
        </div>
      </Card>

      {selectedIds.length > 0 && (
        // The selection strip. It is not a toast and it is not a modal: the rows stay on
        // screen, because the decision an admin is making is about the rows.
        <Card className="flex flex-wrap items-center gap-3" role="region" aria-label="Selected faults">
          <p className="text-sm font-medium">
            {selectedIds.length === 1 ? "1 fault selected" : `${selectedIds.length} faults selected`}
          </p>
          <ConfirmButton
            idleLabel={selectedIds.length === 1 ? "Mark it resolved" : `Mark ${selectedIds.length} resolved`}
            cancelLabel="Leave them open"
            confirmLabel={resolveConfirm(selectedIds.length)}
            subject={selectedIds.length === 1 ? "this fault" : `these ${selectedIds.length} faults`}
            onConfirm={() => resolve(selectedIds, "")}
            className="min-h-11"
          />
          <Button variant="ghost" className="min-h-11" onClick={() => setSelected(new Set())}>Clear</Button>
        </Card>
      )}

      {batch && (
        <Card className="space-y-2">
          <h2 className="text-lg font-semibold" aria-live="polite">
            {`${batch.filter((b) => b.ok).length} of ${batch.length} done.`}
          </h2>
          <ul className="space-y-1 text-sm">
            {batch.map((b) => (
              <li key={b.id} className={b.ok ? "text-text-secondary" : "text-danger-strong"}>
                {b.ok ? "✓ " : "✗ "}{b.said}
              </li>
            ))}
          </ul>
          <Button variant="outline" className="min-h-11" onClick={() => setBatch(null)}>Done</Button>
        </Card>
      )}

      {/* A failed RE-read with rows in hand: the rows stay, the band says they are not being
          updated. A failed FIRST read has nothing to qualify and goes to StateBlock below. */}
      {error !== null && error !== undefined && rows.length > 0 && (
        <Alert tone="danger" live="standing" announceKey="faults-unreachable">{FAULTS_READ_FAILED}</Alert>
      )}

      <StateBlock
        loading={loading}
        error={rows.length > 0 ? null : error}
        action="the fault list"
        failedCaveat="That does not mean there are none."
        onRetry={() => void load(filters)}
        empty={!loading && !error && rows.length === 0}
        emptyTitle={faultsEmptyNotice(boardCount || null, page?.retention_days ?? null)}
        emptyHint={filters.state === "open"
          ? "Anything a board has reported and somebody has since marked resolved is under “Marked resolved”."
          : undefined}
      >
        <div className="space-y-4">
          {boards.map((board) => (
            <Card key={board.key} className="space-y-3">
              <h2 className="text-lg font-semibold">{board.name}</h2>
              <ul className="space-y-4">
                {board.rows.map((row) => (
                  <FaultRow
                    key={row.id}
                    row={row}
                    now={now}
                    timezone={timezone}
                    selected={selected.has(row.id)}
                    onToggle={() => toggle(row.id)}
                    onResolve={(note) => resolve([row.id], note)}
                  />
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </StateBlock>

      <p className="text-xs text-text-muted">
        {page?.retention_days
          ? `Faults are kept for ${page.retention_days} days. One that stops being reported is closed by itself and kept, rather than deleted, so the club's count stays honest.`
          : "Faults are kept for as long as the club's settings say."}
        {checkedFace ? ` Read at ${checkedFace} club time.` : ""}
      </p>
    </div>
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
  const said = explainFault(row);
  const tone = SEVERITY_TONE[row.severity] ?? "info";
  const resolved = Boolean(row.resolved_at);

  return (
    <li className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {!resolved && (
          <label className="inline-flex min-h-11 min-w-11 items-center justify-center">
            <input
              type="checkbox"
              className="h-5 w-5"
              checked={selected}
              onChange={onToggle}
              aria-label={`Select ${said.title}`}
            />
          </label>
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge tone={tone}>{SEVERITY_WORD[row.severity]}</Badge>
            <p className="min-w-0 break-words font-medium text-text-primary">{said.title}</p>
            {/* The raw code stays reachable for whoever has to report it upstream. Losing it
                would make a humanised unknown unsearchable. */}
            {said.unrecognised && (
              <code className="rounded bg-bg-muted px-1 text-xs text-text-muted">{row.code}</code>
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
          {row.detail && !said.unrecognised && (
            <p className="min-w-0 break-words text-xs text-text-muted">{row.detail}</p>
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
          <ConfirmButton
            idleLabel="Mark resolved"
            cancelLabel="Leave it open"
            confirmLabel={resolveConfirm(1)}
            ariaLabel={said.title}
            subject={said.title}
            onConfirm={() => onResolve("")}
            className="min-h-11"
          />
        )}
      </div>
    </li>
  );
}
