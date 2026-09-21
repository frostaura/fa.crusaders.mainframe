import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { Alert } from "../components/Alert";
import { DoorTile } from "../components/doors/DoorTile";
import { FleetShutPanel } from "../components/doors/FleetShutPanel";
import {
  DOORS_PAGE_INTERVAL_MS, attentionRankOf, refreshDoorsView, storeCheckedSince, useDoorsStore,
} from "../components/doors/useDoorsChrome";
import { useTicker } from "../lib/useTicker";
import { isOnline, offlineAfterSecondsFor, relative } from "../lib/deviceLiveness";
import {
  DOORS_EMPTY_HINT, DOORS_EMPTY_NOTICE, DOORS_LIVENESS_SUSPENDED, DOORS_READ_FAILED,
  doorAttentionReason, doorDisplayName, doorStaleChecksNotice, doorsAttentionSummary,
} from "../lib/doorsCopy";
import { withDoorsBoundary } from "../components/doors/DoorsErrorBoundary";
import { endpoints, type AdminSettings, type DoorRow } from "../lib/api";

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
 * this surface is tokens only and 44 px minimum, because it is used standing up.
 * </p>
 *
 * <p>
 * <b>There is no sort control, at any width (D3 / A2.3).</b> A door list sorted by a scan
 * count is a footfall ranking, which is the exact shape P3 exists to prevent — and the first
 * person to sort it has built the attendance report nobody agreed to. Order is
 * needs-attention first, then alphabetical.
 * </p>
 *
 * <p>
 * <b>One shut-state source (C3).</b> The page's read is pushed into `useDoorsChrome` on
 * every poll and after every action, and the banner in the chrome, this page's own summary
 * and the fleet result panel all render from it. Three independent readers is how an admin
 * came to see three different door counts on one screen.
 * </p>
 */

/**
 * <b>A10: name order, always.</b>
 *
 * <p>
 * The overview used to re-sort by severity on every poll, so cards swapped position under a
 * thumb already on its way down — a reviewer tapped a door and landed on a different one. A
 * list an admin has learned the shape of is worth more than a list that is optimally ordered
 * for a state that changes every fifteen seconds; attention is carried by the chips on each
 * card and by the summary line above them, which LINKS to the door that needs somebody.
 * </p>
 */
function sortRows(rows: DoorRow[]): DoorRow[] {
  return [...rows].sort((a, b) => doorDisplayName(a.device).localeCompare(doorDisplayName(b.device)));
}

/**
 * <b>A8 — while the page cannot read, it does not get to say who is reporting.</b>
 *
 * <p>
 * With the ADMIN's phone offline, every age on the page went on ticking from a frozen read;
 * doors flipped one by one to "Not reporting" and the page asserted "nothing can reach it" —
 * about doors that were, as far as anybody knew, perfectly fine. The failing thing was the
 * phone. Two failures is the same threshold the staleness notice uses, so the page tells one
 * story rather than two.
 * </p>
 */
const SUSPEND_LIVENESS_AFTER_FAILURES = 2;

function AdminDoorsPageBody() {
  // E-L6 / B2: ONE reader. The page, the chrome banner and the gear badge all subscribe to
  // this store, and it makes one request no matter how many of them mount at once.
  const store = useDoorsStore(true, DOORS_PAGE_INTERVAL_MS);
  const { view, chrome, loading, failed, failures, checkedAt } = store;
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** C4: what Refresh says back, so pressing it offline is not silence. */
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const now = useTicker(true);

  useEffect(() => {
    // The club's declared heartbeat, for boards that do not carry their own, and the two
    // signal numbers A9's card lines interpolate. Its failure is not this page's failure: a
    // liveness threshold has a documented fallback and a signal with no number does not
    // render at all.
    let cancelled = false;
    endpoints.adminSettingsGet()
      .then((s) => { if (!cancelled) setSettings(s); })
      .catch(() => { /* the fallbacks below */ });
    return () => { cancelled = true; };
  }, []);

  const tenantHeartbeat = settings?.heartbeat_seconds ?? null;
  const signalSettings = {
    spikeMinutes: settings?.door_refusal_spike_minutes ?? null,
    unlockSeconds: settings?.gate_unlock_seconds ?? null,
  };

  /**
   * A8 / C4: Refresh answers immediately, whether or not the club is reachable.
   *
   * Tapped on a phone with no signal it used to do nothing visible at all — the button went
   * back to "Refresh", the ages carried on ticking, and there was no way to tell the request
   * from the network.
   */
  const refreshNow = async () => {
    setRefreshing(true);
    setRefreshNote(null);
    const before = checkedAt;
    await refreshDoorsView();
    setRefreshing(false);
    // The store swallows its own failures — a toast every fifteen seconds while a laptop is
    // off the WiFi is worse than the staleness — so a MANUAL press reads the outcome off
    // whether `checkedAt` moved. Silence is the one answer a press must never get.
    setRefreshNote(storeCheckedSince(before) ? "Checked just now." : "Still can't reach the club.");
  };

  // A8: the liveness verdict is `null` — "this page cannot say" — once the reads themselves
  // are failing. Every consumer takes its unknown arm rather than deriving "Not reporting"
  // from an age that has been frozen since the last successful read.
  const livenessSuspended = failures >= SUSPEND_LIVENESS_AFTER_FAILURES;
  const livenessOf = (row: DoorRow): boolean | null => (livenessSuspended
    ? null
    : isOnline(row.device, offlineAfterSecondsFor(row.device, tenantHeartbeat), now));

  const rows = view ? sortRows(view.doors) : [];
  const attention = rows
    .map((row) => doorAttentionReason(row.device, livenessOf(row), row.signals))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // A10: the summary NAMES a door and LINKS to it, because the cards no longer reorder to put
  // it first. "3 doors need attention" sends nobody anywhere.
  const first = [...attention].sort((a, b) => attentionRankOf(a) - attentionRankOf(b))[0] ?? null;
  const summary = doorsAttentionSummary(
    [...attention].sort((a, b) => attentionRankOf(a) - attentionRankOf(b)).map((a) => a.reason),
  );
  const secondsSinceRead = checkedAt === null ? 0 : Math.max(0, Math.round((now - checkedAt) / 1000));
  const stale = doorStaleChecksNotice(failures, secondsSinceRead);

  return (
    <div className="space-y-6">
      <header className="space-y-2 sm:flex sm:items-start sm:justify-between sm:gap-4 sm:space-y-0">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Doors</h1>
          {/* A16: the header said "Checked 12s ago" confidently for the whole ~30 s a failed
              poll took to be noticed, while the banner below it said something else. Both
              now count from the same `checkedAt` against the same tick, so the two ages on
              one screen cannot disagree. */}
          <p className="text-xs text-text-muted">
            {checkedAt === null ? "Checking…" : `Checked ${relative(new Date(checkedAt).toISOString(), now)}`}
            {` · re-reads every ${DOORS_PAGE_INTERVAL_MS / 1000} seconds while this tab is in front`}
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
          {/* C4: never `disabled` — a browser blurs a disabled element, so disabling the
              control an admin just pressed throws their place away. */}
          <Button variant="outline" onClick={() => void refreshNow()} aria-busy={refreshing}>
            {refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </header>

      {/* A8 / C4: one polite region carrying what Refresh found and whether this page can
          currently say anything about liveness at all. */}
      <p role="status" className="sr-only">{refreshNote ?? ""}</p>
      {livenessSuspended && (
        <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-strong">
          {DOORS_LIVENESS_SUSPENDED}
        </p>
      )}

      {/*
        A10: the banner used to ARRIVE and shift everything under it by 164 px, which on a
        phone moves the card a thumb is already descending on. The slot is reserved, so the
        summary appearing and disappearing across polls costs no layout at all.
      */}
      <div className="min-h-14">
        {summary && (
          <p role="status" className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning-strong">
            {summary}
            {first?.doorId && (
              <>
                {" "}
                <Link to={`/admin/doors/${first.doorId}`} className="font-medium underline">
                  {`Go to ${first.doorName}`}
                </Link>
              </>
            )}
          </p>
        )}
      </div>

      {/* Failed read before empty, always. An admin who reads "no doors" while a door is shut
          goes to look for a board that is fine — a worse false claim than the members page's,
          which is the rule pages/admin-failed-read.test.tsx exists to hold. */}
      {failed && view === null ? (
        <div className="space-y-3">
          <Alert tone="danger">{DOORS_READ_FAILED}</Alert>
          <Button variant="outline" onClick={() => void refreshDoorsView()}>Try again</Button>
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
            chrome={chrome}
            loading={loading}
            failed={failed && view === null}
            reload={refreshDoorsView}
            onRetry={() => void refreshDoorsView()}
          />
          {/* `items-stretch` and an internal footer: B18. Tiles misaligned whenever one door
              carried more chips than its neighbour, so three cards in a row ended with their
              scan counts at three different heights and the eye had to hunt for each. */}
          <div className="grid items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row) => (
              <DoorTile
                key={row.device.id}
                row={row}
                now={now}
                // A8: `null` means "this page cannot currently say". The tile suppresses
                // every liveness claim rather than deriving one from a frozen age.
                online={livenessOf(row)}
                timezone={view!.timezone}
                dayStartedAt={view!.day_started_at}
                settings={signalSettings}
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

/**
 * A1: exported through the doors error boundary, so a rendering fault here shows a heading,
 * a sentence and a way back rather than a blank white document. The routes live in `App.tsx`,
 * which this lane does not own, so the wrapping happens at the page's own export.
 */
export const AdminDoorsPage = withDoorsBoundary(AdminDoorsPageBody);
