import { useCallback, useEffect, useState } from "react";
import { doorEndpoints, type DoorsView } from "../../lib/api";
import { isOnline, offlineAfterSecondsFor } from "../../lib/deviceLiveness";
import { doorAttentionReason, type DoorAttention } from "../../lib/doorsCopy";

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
  /** True while this door is one a shut-all shut, as opposed to one an admin shut on its own. */
  shutByFleet: boolean;
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
};

const NOTHING: DoorsChrome = {
  attention: [], homeAttention: [], shut: 0, total: 0, shutAllActive: false, doors: [],
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
 * in the banner, never in the gear count, and sorted below the fold. A2.6 keeps signals off
 * admin HOME, which is a different screen and a different rule — see
 * {@link AdminDoorsHomeRow}, which still counts only the three.
 * </p>
 */
export function useDoorsChrome(enabled: boolean, routeKey: string): DoorsChrome {
  const [chrome, setChrome] = useState<DoorsChrome>(NOTHING);

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears the cue when the session stops being an admin one
      setChrome(NOTHING);
      publish(NOTHING);
      return;
    }
    let cancelled = false;
    doorEndpoints.doors()
      .then((view) => { if (!cancelled) setChrome(summarise(view)); })
      .catch(() => { /* A cue, not a screen: a failed read shows nothing rather than an error. */ });
    return () => { cancelled = true; };
  }, [enabled, routeKey]);

  // The doors page's own reads and actions, which are far fresher than this hook's
  // navigation-scoped one. Without this the banner in the chrome and the page under it are
  // two independent readers of one fact — which is C3 exactly.
  useEffect(() => subscribe(setChrome), []);

  return chrome;
}

/**
 * The doors page hands its read here, so the chrome above it stops being a second reader.
 *
 * A plain module-level subscriber set rather than a context: the banner lives in `Layout`,
 * above the router's `Outlet`, so a provider would have to wrap the whole app to carry a
 * fact only the doors page produces — and `lib/pendingApplications.ts` is the precedent this
 * product already has for exactly that shape.
 */
const subscribers = new Set<(chrome: DoorsChrome) => void>();

function subscribe(fn: (chrome: DoorsChrome) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function publish(chrome: DoorsChrome) {
  for (const fn of subscribers) fn(chrome);
}

/** Called by the doors page after every poll and after every action that changed a door. */
export function publishDoorsView(view: DoorsView) {
  publish(summarise(view));
}

/**
 * A reader that wants the same summary from a view it already has.
 *
 * The doors page renders from this rather than re-deriving shut counts of its own, which is
 * what makes "the banner, the summary and the result panel agree" a property of the code
 * rather than of three matching implementations.
 */
export function summariseDoors(view: DoorsView): DoorsChrome {
  return summarise(view);
}

/** A stable callback the page can hand to its poll without re-subscribing every render. */
export function usePublishDoorsView() {
  return useCallback((view: DoorsView) => publishDoorsView(view), []);
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
    doors.push({
      id: row.device.id,
      name: row.device.name,
      enabled: row.device.enabled,
      online,
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
  };
}
