import { useEffect, useState } from "react";
import { doorEndpoints, type DoorsView } from "../../lib/api";
import { isOnline, offlineAfterSecondsFor } from "../../lib/deviceLiveness";
import {
  doorAttentionReason, doorDisplayName, doorShutHeard, type DoorAttention,
} from "../../lib/doorsCopy";

/**
 * One door, reduced to the five facts every reader of the shut state needs.
 *
 * `online` is resolved HERE rather than by each reader, because C2 is precisely a reader
 * that knew a door was shut and did not know whether it was reporting — and then said
 * "members can't get in" about a door that may still be admitting them from a cached list.
 */
export type DoorSummary = {
  id: string;
  name: string;
  enabled: boolean;
  online: boolean;
  /**
   * Has this door a `gate_key` — which is to say, is it sent a list at all?
   *
   * B3: an unnamed gate's heartbeat answers `roster: []`, so "keeps admitting booked members
   * from the list it last downloaded" is flatly false of it — and that is what the fleet
   * confirm said about every unreachable door in the club. The fleet control cannot ask the
   * device rows directly (it renders from this summary), so the fact travels with them.
   */
  named: boolean;
  /** True while this door is one a shut-all shut, as opposed to one an admin shut on its own. */
  shutByFleet: boolean;
  /**
   * <b>R3-1: has this SHUT door been told?</b> `undefined` where the API cannot say.
   *
   * It travels with the summary for the reason `named` does: the banner renders from this
   * shape and cannot reach the device rows, and the banner is where "2 confirmed, 1 not yet"
   * was being counted off liveness — which the shut itself froze.
   */
  heardShut?: boolean;
};

/** What the chrome and the doors page both read, and the ONE place either of them reads it. */
export type DoorsChrome = {
  /**
   * One sentence per door that needs somebody, most urgent first. Empty on a failed read.
   *
   * A3: signals are in here — the gear badge, the gear's tooltip and the doors page's own
   * banner all read it, and a door "Refusing a lot" was invisible to every one of them.
   */
  attention: string[];
  /**
   * The same, narrowed to silent / shut / unnamed — admin HOME's list and only Home's.
   *
   * A2.6 is a rule about the home screen specifically: "a badge that fires on a dirty
   * scanner is a badge an admin learns to ignore before the badge that fires on a dead
   * board ever appears". Home is seen on every visit whether or not the visit is about
   * doors, so it keeps the three states somebody must act on. The doors surface — which
   * somebody is on because of doors — carries the four.
   */
  homeAttention: string[];
  shut: number;
  total: number;
  /** The `shut_all_active` flag the fleet control and the banner both key on (C1). */
  shutAllActive: boolean;
  doors: DoorSummary[];
  /**
   * <b>C11 — when the shut state last changed under somebody who did not cause it.</b>
   *
   * <p>
   * The standing banner was `role="alert"`, so a blind admin was interrupted mid-word with
   * the same sentence on every route they visited for the rest of the session — including
   * the admin who had shut the door themselves and had already been told by the control,
   * the toast and the banner's arrival. What is standing is polite; what is NEWS is the
   * club's doors changing state under a reader who did not do it, and only that earns an
   * interruption.
   * </p>
   *
   * <p>
   * A timestamp rather than a boolean because the banner has to be able to tell one
   * interruption from the next: two shuts by two other admins, five minutes apart, are two
   * announcements, and a boolean that is already `true` produces one.
   * </p>
   */
  shutChangedElsewhereAt: number | null;
};

const NOTHING: DoorsChrome = {
  attention: [],
  homeAttention: [],
  shut: 0,
  total: 0,
  shutAllActive: false,
  doors: [],
  shutChangedElsewhereAt: null,
};

/**
 * The doors facts the app chrome carries on every admin route — and the SINGLE SOURCE OF
 * TRUTH for shut state on the doors page itself (C3).
 *
 * <p>
 * <b>C3, which is why this hook grew a `refresh`.</b> Three different door counts could sit
 * on one screen at once: the banner in the chrome read on navigation only, the doors page
 * polled every fifteen seconds, and the fleet result panel was frozen at the instant the
 * server answered. An admin who shut every door saw the banner go on saying "1 of 3" over a
 * page that said three. The page now pushes its own poll and every completed action into
 * this hook, and the banner subscribes to it — so the three cannot disagree without the
 * read itself having failed.
 * </p>
 *
 * <p>
 * <b>Modelled on `usePendingApplicationCount`, deliberately.</b> That hook is the pattern
 * this product already has for "a cue in the chrome, re-read on navigation", and its own
 * comment carries the rule that matters here: <i>a badge is a cue, not a screen — a failed
 * read shows nothing rather than an error.</i> So a failed read produces no dot, no count
 * and no banner: the banner's ABSENCE is the default rather than a claim, which is what
 * stops a failed read rendering a false all-clear.
 * </p>
 *
 * <p>
 * Counted toward attention: silent, shut, unnamed, <b>and signals (A3)</b>. Signals were
 * excluded outright, so a door flagged "Refusing a lot" or "May not be releasing" was never
 * in the banner, never in the gear count, and sorted below the fold.
 * </p>
 */
export function useDoorsChrome(enabled: boolean, _routeKey?: string): DoorsChrome {
  return useDoorsStore(enabled).chrome;
}

// --- the store ---------------------------------------------------------------------

/**
 * Everything every reader of the doors state needs, in ONE place that does ONE read.
 *
 * <p>
 * <b>E-L6.</b> `/admin/doors` fired three identical `GET /admin/doors` on mount: the banner
 * store re-read on navigation, the page polled on its own, and the gear badge read a third
 * time. Three readers of one fact is also C3 — an admin who shut every door could see three
 * different counts on one screen — and the answer to both is the same: the store owns the
 * request, and every reader subscribes.
 * </p>
 *
 * <p>
 * <b>B2.</b> The shut banner re-read only on navigation, so it sat frozen on `/schedule`
 * while another admin shut every door in the club. The store polls on EVERY route.
 * </p>
 */
export type DoorsState = {
  chrome: DoorsChrome;
  /** The last successful read, or null if none has landed. */
  view: DoorsView | null;
  loading: boolean;
  /** True while the most recent attempt failed. A6's "cue, not a screen" rule still holds. */
  failed: boolean;
  /** Consecutive failures. A8 suspends liveness claims at two; see the page. */
  failures: number;
  /** When the last SUCCESSFUL read landed. */
  checkedAt: number | null;
};

const IDLE: DoorsState = {
  chrome: NOTHING, view: null, loading: true, failed: false, failures: 0, checkedAt: null,
};

let state: DoorsState = IDLE;

/**
 * How often the store re-reads on an ordinary route, milliseconds.
 *
 * Thirty seconds is a cue's cadence: the banner exists so that a club does not discover at
 * 05:50 that its doors are still shut, and a reader who is not looking at doors does not need
 * a faster one. The doors surface itself asks for {@link DOORS_PAGE_INTERVAL_MS}.
 */
export const DOORS_CHROME_INTERVAL_MS = 30_000;

/**
 * What the doors pages ask for — the firmware's own minimum heartbeat spacing, so a page
 * cannot be more than one beat behind the fastest board a club can configure.
 */
export const DOORS_PAGE_INTERVAL_MS = 15_000;

const subscribers = new Set<(next: DoorsState) => void>();
/** Each subscriber's requested cadence. The timer runs at the fastest one asked for. */
const cadences = new Map<(next: DoorsState) => void, number>();

let timer: number | null = null;
let listening = false;
/**
 * The read in flight, so N components mounting in one commit make ONE request.
 *
 * This is E-L6's actual fix. Without it, "every reader subscribes" still produces a request
 * per reader the moment each of them asks for a refresh on mount.
 */
let inFlight: Promise<void> | null = null;

// --- C11: whose change was it? ------------------------------------------------------

/**
 * The shut set as it stood at the last successful read, or null before the first one.
 *
 * Null is load-bearing: the FIRST read is not a change, it is the state an admin arrived
 * in. Announcing it assertively would interrupt every admin at sign-in with a fact the
 * banner is about to state politely two inches below.
 */
let lastShutSignature: string | null = null;

/**
 * Set by an action THIS TAB performed, consumed by the next successful read.
 *
 * <p>
 * An admin who shuts a door is looking at the result of their own press: the control says
 * it, the toast says it, and the banner arrives. A fourth telling, assertively, over
 * whatever they were reading, is the noise that teaches somebody to tune out the third.
 * </p>
 */
let ownActionPending = false;

/** Called by every control on this surface that changes a door, BEFORE it re-reads. */
export function markOwnDoorsAction() {
  ownActionPending = true;
}

/** Which doors are shut, as one comparable string. Sorted, so ordering is never a "change". */
function shutSignatureOf(chrome: DoorsChrome): string {
  return chrome.doors.filter((d) => !d.enabled).map((d) => d.id).sort().join(",");
}

/**
 * Stamp a freshly summarised chrome with whether somebody ELSE changed the shut state.
 *
 * <p>
 * <b>The stamp lives for exactly one publish</b>, and that is what makes the banner's
 * announcement a pure function of what it is handed rather than a piece of local state it
 * has to remember having announced. The next read — thirty seconds later at the outside —
 * clears it, so the interruption is said once, and the sr-only node it lives in does not
 * settle into a permanent second copy of a sentence already on screen.
 * </p>
 */
function attributeShutChange(chrome: DoorsChrome): DoorsChrome {
  const signature = shutSignatureOf(chrome);
  const previous = lastShutSignature;
  lastShutSignature = signature;
  const ours = ownActionPending;
  ownActionPending = false;
  // `previous === null` is the FIRST read, which is an arrival rather than news: without it,
  // signing in at a club whose doors are shut interrupts every admin at every sign-in.
  const elsewhere = previous !== null && previous !== signature && !ours;
  return { ...chrome, shutChangedElsewhereAt: elsewhere ? Date.now() : null };
}

function publish(next: DoorsState) {
  state = next;
  for (const fn of subscribers) fn(next);
}

/** Read now, or join the read already going. Never throws — a cue is not a screen. */
export function refreshDoorsView(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = doorEndpoints.doors()
    .then((view) => {
      publish({
        // C11: attributed as it is published, because the answer depends on what was on
        // screen a moment ago — a reader working it out later has only the current state.
        chrome: attributeShutChange(summarise(view)),
        view,
        loading: false,
        failed: false,
        failures: 0,
        checkedAt: Date.now(),
      });
    })
    .catch(() => {
      // The chrome keeps whatever it last knew — the banner's ABSENCE is its default, so a
      // failed read must not be allowed to invent an all-clear either way. What changes is
      // `failures`, which is what A8's suspended liveness keys on.
      publish({ ...state, loading: false, failed: true, failures: state.failures + 1 });
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function fastestCadence(): number {
  let fastest = DOORS_CHROME_INTERVAL_MS;
  for (const ms of cadences.values()) fastest = Math.min(fastest, ms);
  return fastest;
}

function startPolling() {
  stopTimer();
  const tick = () => {
    if (document.visibilityState === "hidden") return;
    void refreshDoorsView();
  };
  timer = window.setInterval(tick, fastestCadence());
  if (!listening) {
    // And a read on the way back IN, rather than up to a whole interval of the state the tab
    // was left in. The outage email links here, and a stale "Reporting" is the whole defect.
    document.addEventListener("visibilitychange", onVisibility);
    listening = true;
  }
}

function onVisibility() {
  if (document.visibilityState === "visible") void refreshDoorsView();
}

function stopTimer() {
  if (timer !== null) { window.clearInterval(timer); timer = null; }
}

function stopPolling() {
  stopTimer();
  if (listening) { document.removeEventListener("visibilitychange", onVisibility); listening = false; }
  // Back to the state a fresh admin session starts in, so a sign-out cannot leave a previous
  // club's counts sitting in the chrome.
  state = IDLE;
  // C11: and a fresh session's first read is an ARRIVAL, not a change somebody made under
  // this reader. Without this, signing in at a club whose doors are shut interrupts.
  lastShutSignature = null;
  ownActionPending = false;
}

/** How recent a landed read must be for a joining reader to take it rather than read again. */
export const DOORS_JOIN_FRESH_MS = 2_000;

function justRead(): boolean {
  return state.checkedAt !== null && Date.now() - state.checkedAt < DOORS_JOIN_FRESH_MS;
}

/**
 * Subscribe to the one doors read.
 *
 * `intervalMs` is a REQUEST, not a promise: the timer runs at the fastest cadence any current
 * subscriber asked for, because two timers over one endpoint is the thing being removed.
 */
export function useDoorsStore(enabled: boolean, intervalMs = DOORS_CHROME_INTERVAL_MS): DoorsState {
  const [snapshot, setSnapshot] = useState<DoorsState>(state);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the cue when the session stops being an admin one
      setSnapshot(IDLE);
      if (subscribers.size === 0) stopPolling();
      return;
    }
    subscribers.add(setSnapshot);
    cadences.set(setSnapshot, intervalMs);
    startPolling();
    // Hands the joining reader what the store already knows.
    setSnapshot(state);
    // A reader joining moments after a read landed takes that read (perf lane, 2026-09-30): the
    // admin frame is a lazy chunk now, and its readers can mount just after the chrome's read
    // finished — the second identical GET E-L6 exists to prevent. Older than that, it reads.
    if (!justRead()) void refreshDoorsView();
    return () => {
      subscribers.delete(setSnapshot);
      cadences.delete(setSnapshot);
      if (subscribers.size === 0) stopPolling(); else startPolling();
    };
  }, [enabled, intervalMs]);

  return snapshot;
}

/**
 * Did a successful read land after `since`? — what a MANUAL Refresh answers with (A8 / C4).
 *
 * The store swallows its own failures, so a press that produced nothing visible is exactly
 * the silence a reviewer met on a phone with no signal. Read off the store rather than off a
 * React snapshot, because the answer is needed in the same turn the request finished in.
 */
export function storeCheckedSince(since: number | null): boolean {
  if (state.checkedAt === null) return false;
  return since === null || state.checkedAt > since;
}

/**
 * Silent, then shut, then unnamed, then signalling — the same order the doors page puts its
 * tiles in.
 *
 * <p>
 * It matters because the gear's tooltip NAMES one door and counts the rest, and a cue that
 * names the least urgent of three is a cue that sends an admin to the wrong board. A door
 * nobody can reach outranks one the club shut on purpose, which outranks one that merely has
 * a job waiting, which outranks one that is turning people away but is otherwise healthy.
 * </p>
 */
export function attentionRankOf(a: DoorAttention): number {
  if (a.kind === "silent") return 0;
  if (a.kind === "shut") return 1;
  if (a.kind === "unnamed") return 2;
  return 3;
}

/**
 * Was this door shut TOGETHER, as opposed to on its own (C1)?
 *
 * <p>
 * Three sources, most authoritative first, because the three landed in three different
 * changes and the page has to be right against all of them:
 * </p>
 *
 * <ol>
 *   <li><b>`shut_together`</b> — the server's own list, and the only one that is right in
 *       every case.</li>
 *   <li><b>`shut_by_shut_all_at`</b> on the door row, which answers the same question per
 *       door.</li>
 *   <li><b>`shut_all_active`</b>, the tenant-wide flag. Wrong in exactly one case — a door
 *       shut on its own WHILE a shut-all is standing — which is a reason to want the first
 *       two, not a reason to guess differently.</li>
 * </ol>
 */
function shutTogetherHas(view: DoorsView, id: string): boolean {
  if (view.shut_together) return view.shut_together.some((d) => d.id === id);
  const row = view.doors.find((d) => d.device.id === id)?.device;
  if (row?.shut_by_shut_all_at !== undefined) return row.shut_by_shut_all_at !== null;
  return view.shut_all_active === true;
}

function summarise(view: DoorsView): DoorsChrome {
  const now = Date.now();
  const ranked: { rank: number; reason: string; signal: boolean }[] = [];
  const doors: DoorSummary[] = [];
  for (const row of view.doors) {
    const online = isOnline(row.device, offlineAfterSecondsFor(row.device, null), now);
    const attention = doorAttentionReason(row.device, online, row.signals);
    if (attention) {
      ranked.push({
        rank: attentionRankOf(attention), reason: attention.reason, signal: attention.kind === "signal",
      });
    }
    const heard = doorShutHeard(row.device);
    doors.push({
      id: row.device.id,
      // A11 / R3-21: ONE fallback for a door nobody has named. The raw `name` is the
      // registration placeholder "Door gate", so the banner and the per-door links named
      // every unnamed board in the club identically while the tiles beside them said
      // "Unnamed scanner (gate-44c103)".
      name: doorDisplayName(row.device),
      enabled: row.device.enabled,
      online,
      named: row.device.gate_key !== null,
      // A door is "shut together" only while a shut-all is standing. Without this the page
      // cannot tell a fleet shut from a door somebody shut on its own, which is the whole
      // of C1 — "Reopen all 3" against a club where only an individually-shut door was shut
      // answered `{"doors":[]}` and printed "0 doors reopened" with no explanation.
      //
      // Per-door when the API carries it (`shut_by_shut_all_at`, which WIRE-W1 §5 puts on
      // the Device row), and the tenant-wide flag otherwise. The fallback is wrong in
      // exactly one case — a door shut on its own WHILE a shut-all is standing — and that
      // is a case the tenant flag cannot distinguish at all, so it is a reason to want the
      // field, not a reason to guess differently.
      shutByFleet: !row.device.enabled && shutTogetherHas(view, row.device.id),
      heardShut: heard.state === "unknown" ? undefined : heard.state === "confirmed",
    });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return {
    attention: ranked.map((entry) => entry.reason),
    homeAttention: ranked.filter((entry) => !entry.signal).map((entry) => entry.reason),
    shut: doors.filter((d) => !d.enabled).length,
    total: doors.length,
    shutAllActive: view.shut_all_active === true,
    doors,
    // C11: `summarise` is pure and cannot know whose change this is — it sees one view and
    // no history. The attribution is stamped on at publish time, where the previous read is
    // still in hand; a reader that summarises a view of its own gets the honest null.
    shutChangedElsewhereAt: null,
  };
}
