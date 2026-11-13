import type { AdminDevice, MemberCodeBoardKeys, MemberCodeRollout, MemberCodeRolloutBoard } from "./api";
import { at, boardName, plural } from "./deviceV3Copy";

/**
 * The member-code rollout in words (member-code §8; FA-3, MCV1-03, MCV1-07, MCV1-09).
 *
 * <p>
 * <b>Three states, read from the server, never inferred.</b> <i>Held</i>: an admin stopped the
 * automatic move (a rollback sets it). <i>Blocked</i>: a board the server names is not ready — an
 * acknowledged board that does not speak `codes:m1`, or an enabled court box nobody has
 * acknowledged that was heard this week (it can block, never vote). <i>Clear</i>: nothing stands
 * in the way, so the next step happens by itself (or has).
 * </p>
 */

export const PHASES = ["legacy", "v1", "v1_only"] as const;
export type Phase = (typeof PHASES)[number];

export const PHASE_WORDS: Readonly<Record<string, string>> = {
  legacy: "Old codes only — phones still show the old code; new codes are accepted where they are scanned",
  v1: "New codes — every board reads them; old codes still work online until the cut-off",
  v1_only: "New codes only — old codes are refused everywhere",
};

export type RolloutState = "held" | "blocked" | "clear";

export function rolloutState(rollout: MemberCodeRollout): RolloutState {
  if (rollout.manual_hold) return "held";
  if (rollout.blocking.length > 0) return "blocked";
  return "clear";
}

/** Is this blocking board one an admin has not acknowledged yet (it blocks without voting, MCV1-03)? */
export function isUnacknowledged(board: MemberCodeRolloutBoard, rollout: MemberCodeRollout, devices: readonly AdminDevice[]): boolean {
  if (rollout.unacknowledged.some((u) => u.id === board.id)) return true;
  return devices.find((d) => d.id === board.id)?.auto_registered === true;
}

export function phaseAfter(phase: string): Phase | null {
  const i = PHASES.indexOf(phase as Phase);
  return i >= 0 && i < PHASES.length - 1 ? PHASES[i + 1] : null;
}

export function phaseBefore(phase: string): Phase | null {
  const i = PHASES.indexOf(phase as Phase);
  return i > 0 ? PHASES[i - 1] : null;
}

/** The headline under the phase: what happens next, and when. */
export function rolloutLine(rollout: MemberCodeRollout): string {
  const state = rolloutState(rollout);
  if (state === "held") {
    const who = rollout.manual_hold_by ? ` by ${rollout.manual_hold_by}` : "";
    return `Held${who} since ${at(rollout.manual_hold_at)}: nothing moves on by itself until the hold is lifted.`;
  }
  if (rollout.phase === "legacy") {
    if (state === "blocked") {
      return `Waiting on ${plural(rollout.blocking.length, "board")} before the club moves to new codes by itself.`;
    }
    return "Every board is ready. The club moves to new codes by itself once every court box has been sent its keys.";
  }
  if (rollout.phase === "v1") {
    const due = rollout.cutoff_due_at ? ` on ${at(rollout.cutoff_due_at)}` : "";
    return `On new codes since ${at(rollout.cutover_at)}. Old codes stop working${due}`
      + ` (${rollout.cutoff_days} days after the move).`;
  }
  return `New codes only since ${at(rollout.cutoff_at)}.`;
}

/** Why one board blocks, in words. */
export function blockingWhy(board: MemberCodeRolloutBoard, unacknowledged: boolean): string {
  if (unacknowledged) {
    return `${boardName(board)} has not been checked by an admin. Acknowledge it (its courts are right) or take it out of service.`;
  }
  const seen = board.last_seen_at ? `last heard ${at(board.last_seen_at)}` : "never heard";
  return `${boardName(board)} does not read new codes yet (firmware ${board.running_version ?? "unknown"}, ${seen}).`
    + " Update it, or take it out of service if it is gone.";
}

/** One board's member-code keys (MCV1-07): how many it was last sent, and how many did not fit. */
export function keysLine(keys: MemberCodeBoardKeys): string {
  const sent = typeof keys.keys_sent === "number" ? `${plural(keys.keys_sent, "key")} last sent` : "no keys sent yet";
  const when = keys.keys_sent_at ? ` ${at(keys.keys_sent_at)}` : "";
  const trimmed = typeof keys.keys_trimmed === "number" && keys.keys_trimmed > 0
    ? ` — ${keys.keys_trimmed} did not fit, so those members cannot be checked while it is offline` : "";
  return `${boardName(keys)}: ${sent}${when}${trimmed}.`;
}

export const ROLLOUT_COPY = {
  holdTitle: "Hold the member-code rollout?",
  hold: "The club stays on the phase it is on: no automatic move to new codes, and no cut-off of the old ones, until the"
    + " hold is lifted. Use it while the last flash is being checked.",
  held: "The rollout is held.",
  releaseTitle: "Lift the hold?",
  release: "The rollout moves on by itself again as soon as every board is ready.",
  released: "The hold is lifted.",
  backTitle: (to: string) => `Go back to “${PHASE_WORDS[to]?.split(" —")[0] ?? to}”?`,
  back: "Members' phones switch back on their next refresh, and the rollout is held until you lift the hold. Use it if new"
    + " codes misbehave at a box.",
  backDone: (to: string) => `Back to ${PHASE_WORDS[to]?.split(" —")[0]?.toLowerCase() ?? to}. The rollout is held.`,
  forwardTitle: (to: string) => `Move on to “${PHASE_WORDS[to]?.split(" —")[0] ?? to}” now?`,
  forward: (to: string) => (to === "v1_only"
    ? "Old codes stop working everywhere at once — a member whose phone still shows one is refused at every box and door."
    : "Phones switch to new codes on their next refresh. Old codes still work online until the cut-off."),
  forwardDone: (to: string) => `Moved to ${PHASE_WORDS[to]?.split(" —")[0]?.toLowerCase() ?? to}.`,
  acknowledgeTitle: (name: string) => `Acknowledge ${name}?`,
  acknowledge: (courts: string) => `Its courts stay as they are — ${courts}. Check them against the box before you confirm:`
    + " once acknowledged it is sent its court list, the snapshot of what should be lit, and its member-code keys.",
  acknowledged: (name: string) => `${name} is acknowledged.`,
  disableTitle: (name: string) => `Take ${name} out of service?`,
  disable: "It stops blocking the rollout and stops being trusted for lights or doors until it is put back in service.",
  disabled: (name: string) => `${name} is out of service.`,
};
