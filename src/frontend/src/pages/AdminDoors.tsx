import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { DoorTile } from "../components/doors/DoorTile";
import { FleetShutPanel } from "../components/doors/FleetShutPanel";
import { useTicker } from "../lib/useTicker";
import { isOnline, offlineAfterSecondsFor, relative } from "../lib/deviceLiveness";
import {
  DOORS_EMPTY_HINT, DOORS_EMPTY_NOTICE, DOORS_READ_FAILED, doorNeedsAttention,
  doorStaleChecksNotice, doorsAttentionSummary,
} from "../lib/doorsCopy";
import { doorEndpoints, endpoints, type DoorRow, type DoorsView } from "../lib/api";

/**
 * Doors — "is the front door working?", answered in one glance.
 *
 * <p>
 * This is the only screen on the doors surface an admin opens under time pressure, standing
 * in a club with a member waiting, so nothing on it is behind a disclosure and nothing on it
 * writes except the fleet control. Every other mutation is on a door's own page.
 * </p>
 *
 * <p>
 * <b>Colour comes from `AdminSettings.tsx`, not from `AdminDevices.tsx`.</b> Devices uses raw
 * `slate-*` / `amber-*` / `emerald-*` classes throughout and sizes every button at 32 px;
 * this surface is tokens only and `h-11` only, because it is used standing up.
 * </p>
 *
 * <p>
 * <b>There is no sort control, at any width (D3 / A2.3).</b> A door list sorted by a scan
 * count is a footfall ranking, which is the exact shape P3 exists to prevent — and the first
 * person to sort it has built the attendance report nobody agreed to. Order is
 * needs-attention first, then alphabetical.
 * </p>
 */

/**
 * How often the page re-reads, milliseconds.
 *
 * Fifteen seconds is the firmware's own minimum heartbeat spacing, so the page cannot be
 * more than one beat behind the fastest board a club can configure. Same number and same
 * reason as the Devices page.
 */
const REFRESH_MS = 15_000;

/** Needs-attention first — silent, then shut, then unnamed — then alphabetical by name. */
function attentionRank(row: DoorRow, now: number): number {
  const online = isOnline(row.device, offlineAfterSecondsFor(row.device, null), now);
  if (row.device.enabled && !online) return 0;
  if (!row.device.enabled) return 1;
  if (row.device.gate_key === null) return 2;
  return 3;
}

function sortRows(rows: DoorRow[], now: number): DoorRow[] {
  return [...rows].sort((a, b) => {
    const rank = attentionRank(a, now) - attentionRank(b, now);
    if (rank !== 0) return rank;
    return a.device.name.localeCompare(b.device.name);
  });
}

export function AdminDoorsPage() {
  const [view, setView] = useState<DoorsView | null>(null);
  const [tenantHeartbeat, setTenantHeartbeat] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [failures, setFailures] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useTicker(true);

  const read = useCallback(async () => {
    const next = await doorEndpoints.doors();
    setView(next);
    setFailed(false);
    setFailures(0);
    setCheckedAt(Date.now());
  }, []);

  const load = useCallback(async () => {
    try {
      await read();
    } catch {
      setFailed(true);
      setView(null);
    } finally {
      setLoading(false);
    }
    // The club's declared heartbeat, for boards that do not carry their own. Its failure is
    // not this page's failure: a liveness threshold has a documented fallback and the doors
    // read does not.
    try { setTenantHeartbeat((await endpoints.adminSettingsGet()).heartbeat_seconds); } catch { /* fallback */ }
  }, [read]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount loader; sync loading flag is the house idiom
  useEffect(() => { void load(); }, [load]);

  /**
   * Keeps the liveness live, and suspends while nobody is looking.
   *
   * <p>
   * A failed poll is SWALLOWED — one toast every fifteen seconds while a laptop is off the
   * WiFi is worse than the staleness — but counted, and at two the "Checked" line says so.
   * The Devices page swallows silently and simply stops advancing, which is honest but mute.
   * </p>
   *
   * <p>
   * No `mounted` ref and no early-return guard: StrictMode's mount → cleanup → mount leaves a
   * cleanup-written ref false before the first tick, which is the shape behind two live
   * defects in this repo. Clearing the interval is the whole cleanup.
   * </p>
   */
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void read().catch(() => setFailures((n) => n + 1));
    };
    // And a read on the way back IN, rather than up to fifteen seconds of the state the tab
    // was left in — the outage email links here, and a stale "Reporting" is the whole defect.
    const onVisibility = () => { if (document.visibilityState === "visible") tick(); };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [read]);

  const refreshNow = async () => {
    setRefreshing(true);
    try { await read(); } catch { setFailures((n) => n + 1); } finally { setRefreshing(false); }
  };

  const rows = view ? sortRows(view.doors, now) : [];
  const attention = rows
    .map((row) => doorNeedsAttention(
      row.device,
      isOnline(row.device, offlineAfterSecondsFor(row.device, tenantHeartbeat), now),
    ))
    .filter((reason): reason is string => reason !== null);
  const summary = doorsAttentionSummary(attention);
  const stale = doorStaleChecksNotice(
    failures,
    checkedAt === null ? 0 : Math.max(0, Math.round((now - checkedAt) / 1000)),
  );

  return (
    <div className="space-y-6">
      <header className="space-y-2 sm:flex sm:items-start sm:justify-between sm:gap-4 sm:space-y-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Doors</h1>
          <p className="text-xs text-text-muted">
            {checkedAt === null ? "Checking…" : `Checked ${relative(new Date(checkedAt).toISOString(), now)}`}
            {` · re-reads every ${REFRESH_MS / 1000} seconds while this tab is in front`}
          </p>
          {stale && <p className="mt-1 text-xs text-warning-strong">{stale}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="/admin/doors/log"
            className="inline-flex min-h-11 items-center rounded-lg border border-control bg-bg-surface px-5 text-sm font-medium"
          >
            All scans, all doors
          </Link>
          <Button variant="outline" onClick={() => void refreshNow()} disabled={refreshing || loading}>
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </header>

      {summary && <p role="status" className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-strong">{summary}</p>}

      {/* Failed read before empty, always. An admin who reads "no doors" while a door is shut
          goes to look for a board that is fine — a worse false claim than the members page's,
          which is the rule pages/admin-failed-read.test.tsx exists to hold. */}
      {failed ? (
        <div className="space-y-3">
          <Alert tone="danger">{DOORS_READ_FAILED}</Alert>
          <Button variant="outline" onClick={() => void load()}>Try again</Button>
        </div>
      ) : loading ? (
        <p className="text-sm text-text-secondary">Loading the club's doors…</p>
      ) : rows.length === 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">{DOORS_EMPTY_NOTICE}</p>
          <p className="text-sm text-text-muted">{DOORS_EMPTY_HINT}</p>
          <Link to="/admin/devices" className="inline-flex min-h-11 items-center text-sm text-accent-strong">
            Go to Devices
          </Link>
        </div>
      ) : (
        <>
          <FleetShutPanel
            doors={rows.map((row) => row.device)}
            loading={loading}
            failed={failed}
            reload={read}
            onRetry={() => void load()}
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <DoorTile
                key={row.device.id}
                row={row}
                now={now}
                tenantHeartbeat={tenantHeartbeat}
                timezone={view!.timezone}
                dayStartedAt={view!.day_started_at}
              />
            ))}
          </div>
        </>
      )}

      <p className="text-sm">
        <Link to="/admin/devices" className="inline-flex min-h-11 items-center text-accent-strong">
          Court boxes are on Devices
        </Link>
      </p>
    </div>
  );
}
