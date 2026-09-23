import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { endpoints } from "./api";
import { adminEndpoints, type DeviceErrorCounts } from "./adminApi";
import { useAuth } from "./auth";
import { pendingApplicationsVersion, subscribePendingApplications } from "./pendingApplications";
import { refreshDoorsView, useDoorsStore } from "../components/doors/useDoorsChrome";

/**
 * What needs an admin — pending applications, doors, faults — as ONE read the whole console shares.
 *
 * <p>
 * Lifted out of `components/Layout.tsx` (its `usePendingApplicationCount`, the doors-attention read
 * and `monitoringAttentionLabel`) so the app shell's Admin tab badge, the admin rail's three badges
 * and the Overview's "Needs attention" cards count the same things from the same responses. Three
 * readers of one fact that each fetched it themselves is C3: an admin could see three different
 * numbers on one screen.
 * </p>
 *
 * <ul>
 *   <li><b>pending</b> — `GET /admin/members?status=PendingApproval`, counted. Re-read on every
 *   navigation AND whenever `lib/pendingApplications` says the set moved (approve/reject patch the
 *   members table in place without a navigation — the reason that store exists).</li>
 *   <li><b>doors</b> — `useDoorsStore`, the doors surface's single store (it polls on every route
 *   and dedupes its own request). Counted from `attention`, signals included (A3), exactly as the
 *   chrome's badge counted it.</li>
 *   <li><b>faults</b> — `GET /admin/monitoring/summary`'s `open` counts: critical + error + warning.
 *   <b>Info is not counted</b>: a board records every boot at info (`DeviceErrorCodes.Boot`), and a
 *   badge that fires every time a board restarts is a badge an admin learns to ignore (A2.6). Layout
 *   passed 0 here because the fault store did not exist yet; it does now, so the number is real.</li>
 * </ul>
 *
 * <p>
 * <b>A failed read yields ZERO in the counts — and says so in `failed`.</b> A badge is a cue, not a
 * screen (Layout's rule, kept): a badge that turned into an error icon over a flaky connection would
 * be noise on every route. But a zero from a failed read is not an answer, so every consumer that
 * would otherwise present the zero as a claim — the Overview's "All clear" above all — must check
 * `failed` first. The counts keep their LAST SUCCESSFUL value through a failed re-read rather than
 * dropping to zero: what the club last said is still the best cue there is.
 * </p>
 */

export type AttentionSource = "pending" | "doors" | "faults";

export type AdminAttention = {
  /** Membership applications awaiting review. */
  pending: number;
  /** Doors needing somebody (silent, shut, unnamed, or signalling). */
  doors: number;
  /** Open faults at warning severity or worse. */
  faults: number;
  /** pending + doors + faults — the Admin tab's single badge. */
  total: number;
  /** The whole of `total` as one sentence, "" at zero. The accessible name for that badge. */
  label: string;
  /**
   * No read of at least one source has answered yet — and ALWAYS true while the session is not
   * (yet) an admin one, which includes the auth probe on a cold load. Zeros from a hook that has
   * not been allowed to read are not "nothing needs attention"; an Overview that trusted them
   * flashed "All clear" for the half-second before `whoami` answered.
   */
  loading: boolean;
  /** A re-read is in flight (after the first). */
  refreshing: boolean;
  /** The sources whose most recent read failed. Their counts are the last good value, or 0. */
  failed: readonly AttentionSource[];
  /** One sentence per door needing somebody, most urgent first (from the doors store). */
  doorReasons: readonly string[];
  /** The open-fault breakdown by severity, as the server sent it. */
  faultCounts: DeviceErrorCounts;
  /** When the last read of every source answered successfully, or null. */
  checkedAt: number | null;
  /** Re-read all three now. Never rejects. */
  refresh: () => Promise<void>;
};

// --- the pure wording, exported for the shell lane --------------------------------------

/** "1 membership application awaiting review". Layout's wording, verbatim. */
export function pendingApplicationsLabel(count: number): string {
  return `${count} membership ${count === 1 ? "application" : "applications"} awaiting review`;
}

/** "1 door needs attention" / "2 doors need attention". */
export function doorsAttentionLabel(count: number): string {
  return `${count} ${count === 1 ? "door needs" : "doors need"} attention`;
}

/**
 * "1 fault needs attention" / "3 faults need attention".
 *
 * <p>
 * Faults, not boards. Layout's placeholder said "N boards have a fault", but the count is of fault
 * ROWS — one board can hold three — so the sentence would have been wrong the day a real number
 * arrived.
 * </p>
 */
export function faultsAttentionLabel(count: number): string {
  return `${count} ${count === 1 ? "fault needs" : "faults need"} attention`;
}

/** Joins "a", "a and b", "a, b and c". */
function joinSentence(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * What needs attention in Monitoring, as one sentence — both halves, or an admin who sees a number
 * and finds every door fine concludes the badge is wrong. Same signature as Layout's export, so the
 * shell can switch its import without changing a call. "" when both are zero.
 */
export function monitoringAttentionLabel(doors: number, faults = 0): string {
  const parts: string[] = [];
  if (doors > 0) parts.push(doorsAttentionLabel(doors));
  if (faults > 0) parts.push(faultsAttentionLabel(faults));
  return joinSentence(parts);
}

/** Everything, as one sentence: the Admin tab badge's name. "" when nothing needs attention. */
export function adminAttentionLabel({ pending, doors, faults }: { pending: number; doors: number; faults: number }): string {
  const parts: string[] = [];
  if (pending > 0) parts.push(pendingApplicationsLabel(pending));
  if (doors > 0) parts.push(doorsAttentionLabel(doors));
  if (faults > 0) parts.push(faultsAttentionLabel(faults));
  return joinSentence(parts);
}

/** Open faults worth a badge: critical + error + warning. Info (boots) is deliberately left out. */
export function openFaultCount(counts: DeviceErrorCounts | undefined): number {
  if (!counts) return 0;
  return (counts.critical ?? 0) + (counts.error ?? 0) + (counts.warning ?? 0);
}

/** The count a badge key names, and the sentence that is its accessible name. */
export function attentionBadge(
  key: AttentionSource,
  attention: Pick<AdminAttention, "pending" | "doors" | "faults">,
): { count: number; label: string } {
  const count = attention[key];
  const label = key === "pending"
    ? pendingApplicationsLabel(count)
    : key === "doors" ? doorsAttentionLabel(count) : faultsAttentionLabel(count);
  return { count, label };
}

// --- the counts store (pending + faults) -------------------------------------------------

type Counted = { value: number; error: unknown; readAt: number | null };

type CountsState = {
  pending: Counted;
  faults: Counted & { breakdown: DeviceErrorCounts };
  /** Nothing has answered yet. */
  loading: boolean;
  inFlight: boolean;
};

const IDLE: CountsState = {
  pending: { value: 0, error: null, readAt: null },
  faults: { value: 0, error: null, readAt: null, breakdown: {} },
  loading: true,
  inFlight: false,
};

let state: CountsState = IDLE;
const listeners = new Set<() => void>();
let current: Promise<void> | null = null;
/** Bumped by a reset, so a read that started in the previous session cannot publish into this one. */
let generation = 0;

function publish(next: CountsState) {
  state = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    // Back to the state a fresh admin session starts in, so a sign-out cannot leave a previous
    // club's counts behind for the next person on a shared desk machine.
    if (listeners.size === 0) reset();
  };
}

function reset() {
  generation += 1;
  current = null;
  state = IDLE;
}

function snapshot(): CountsState {
  return state;
}

function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

/** Read both counts now, or join the read already going. Never rejects. */
export function refreshAttentionCounts(): Promise<void> {
  if (current) return current;
  const mine = generation;
  publish({ ...state, inFlight: true });
  current = Promise.all([
    settle(endpoints.adminMembers("PendingApproval")),
    settle(adminEndpoints.monitoringSummary()),
  ]).then(([pending, summary]) => {
    if (mine !== generation) return;
    const now = Date.now();
    publish({
      loading: false,
      inFlight: false,
      pending: pending.ok
        ? { value: pending.value.length, error: null, readAt: now }
        : { ...state.pending, error: pending.error },
      faults: summary.ok
        ? { value: openFaultCount(summary.value.open), error: null, readAt: now, breakdown: summary.value.open ?? {} }
        : { ...state.faults, error: summary.error },
    });
  }).finally(() => {
    if (mine === generation) current = null;
  });
  return current;
}

/** How often the counts re-read on their own while somebody is looking. The doors store polls at 30s. */
export const ATTENTION_INTERVAL_MS = 60_000;

function useCountsStore(enabled: boolean, routeKey: string): CountsState {
  const counts = useSyncExternalStore(subscribe, snapshot, snapshot);
  const changeVersion = useSyncExternalStore(subscribePendingApplications, pendingApplicationsVersion, pendingApplicationsVersion);

  useEffect(() => {
    if (enabled) void refreshAttentionCounts();
  }, [enabled, routeKey, changeVersion]);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState !== "hidden") void refreshAttentionCounts(); };
    const timer = window.setInterval(tick, ATTENTION_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled]);

  return enabled ? counts : IDLE;
}

function failedSources(counts: CountsState, doorsFailed: boolean): AttentionSource[] {
  const failed: AttentionSource[] = [];
  if (counts.pending.error) failed.push("pending");
  if (doorsFailed) failed.push("doors");
  if (counts.faults.error) failed.push("faults");
  return failed;
}

/** The oldest of the three successful reads, or null while any has never succeeded. */
function oldestRead(counts: CountsState, doorsCheckedAt: number | null): number | null {
  const reads = [counts.pending.readAt, counts.faults.readAt, doorsCheckedAt];
  if (reads.some((at) => at === null)) return null;
  return Math.min(...(reads as number[]));
}

/**
 * The console's attention, live.
 *
 * <p>
 * `enabled` defaults to "this session is an admin one"; pass it explicitly to override. Mount it as
 * often as you like — the requests are shared (the counts store and the doors store each dedupe
 * their own read), so the shell's Admin tab and the rail inside it cost one read, not two.
 * </p>
 */
export function useAdminAttention(options: { enabled?: boolean } = {}): AdminAttention {
  const auth = useAuth();
  const { pathname } = useLocation();
  const enabled = options.enabled ?? (auth.status === "authenticated" && auth.isAdmin);
  const counts = useCountsStore(enabled, pathname);
  const doorsStore = useDoorsStore(enabled);

  const refresh = useCallback(async () => {
    await Promise.all([refreshAttentionCounts(), refreshDoorsView()]);
  }, []);

  const pending = counts.pending.value;
  const doors = doorsStore.chrome.attention.length;
  const faults = counts.faults.value;
  return {
    pending,
    doors,
    faults,
    total: pending + doors + faults,
    label: adminAttentionLabel({ pending, doors, faults }),
    loading: !enabled || counts.loading || (doorsStore.loading && doorsStore.checkedAt === null),
    refreshing: counts.inFlight,
    failed: failedSources(counts, doorsStore.failed),
    doorReasons: doorsStore.chrome.attention,
    faultCounts: counts.faults.breakdown,
    checkedAt: oldestRead(counts, doorsStore.checkedAt),
    refresh,
  };
}
