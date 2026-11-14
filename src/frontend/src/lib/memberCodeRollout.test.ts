import { describe, expect, it } from "vitest";
import type { AdminDevice, MemberCodeRollout } from "./api";
import {
  PHASE_WORDS,
  blockingWhy, isUnacknowledged, keysLine, phaseAfter, phaseBefore, rolloutLine, rolloutState,
} from "./memberCodeRollout";

/**
 * The member-code rollout's states (member-code §8; FA-3, MCV1-03, MCV1-07, MCV1-09): held,
 * blocked and clear are read from the server's answer, never inferred, and each blocker says why.
 */

const board = (id: string, extra: Record<string, unknown> = {}) => ({
  id, device_code: `box-${id}`, name: `Box ${id}`, kind: "CourtBox", running_version: "2.3.0",
  capabilities: null, last_seen_at: "2026-11-13T16:00:00Z", ...extra,
});

const rollout = (extra: Partial<MemberCodeRollout> = {}): MemberCodeRollout => ({
  phase: "legacy", cutover_at: null, cutoff_at: null, cutoff_days: 14, cutoff_due_at: null,
  enabled_boards: 3, ready_boards: 3, blocking: [], manual_hold: false, manual_hold_by: null, manual_hold_at: null,
  unacknowledged: [], ...extra,
});

describe("the rollout's state", () => {
  it("is clear with no blocker and no hold", () => {
    expect(rolloutState(rollout())).toBe("clear");
    expect(rolloutLine(rollout())).toMatch(/^Every board is ready/);
  });

  it("is blocked by any board the server names", () => {
    const r = rollout({ blocking: [board("a")], ready_boards: 2 });
    expect(rolloutState(r)).toBe("blocked");
    expect(rolloutLine(r)).toBe("Waiting on 1 board before the club moves to new codes by itself.");
  });

  it("is held when an admin held it, whatever is blocking", () => {
    const r = rollout({ blocking: [board("a")], manual_hold: true, manual_hold_by: "Dean", manual_hold_at: "2026-11-13T16:00:00Z" });
    expect(rolloutState(r)).toBe("held");
    expect(rolloutLine(r)).toMatch(/^Held by Dean since .+: nothing moves on by itself/);
  });

  it("says when old codes stop, once cut over", () => {
    const r = rollout({ phase: "v1", cutover_at: "2026-11-13T17:54:00Z", cutoff_due_at: "2026-11-27T17:54:00Z" });
    expect(rolloutLine(r)).toMatch(/^On new codes since .+\. Old codes stop working on .+ \(14 days after the move\)\.$/);
  });
});

describe("a blocking board", () => {
  it("an unacknowledged court box blocks without voting (MCV1-03)", () => {
    const b = board("a");
    expect(isUnacknowledged(b, rollout({ blocking: [b], unacknowledged: [b] }), [])).toBe(true);
    expect(blockingWhy(b, true)).toMatch(/has not been checked by an admin\. Acknowledge it/);
  });

  it("is unacknowledged by the device row too, when the server lists it only as blocking", () => {
    const b = board("a");
    const row = { id: "a", auto_registered: true } as AdminDevice;
    expect(isUnacknowledged(b, rollout({ blocking: [b] }), [row])).toBe(true);
    expect(isUnacknowledged(b, rollout({ blocking: [b] }), [{ ...row, auto_registered: false }])).toBe(false);
  });

  it("an acknowledged board that does not read new codes names its firmware", () => {
    expect(blockingWhy(board("a"), false)).toMatch(/^Box a does not read new codes yet \(firmware 2\.3\.0, last heard .+\)/);
    expect(blockingWhy(board("a", { last_seen_at: null, running_version: null }), false)).toMatch(/firmware unknown, never heard/);
  });
});

describe("each board's keys (MCV1-07)", () => {
  it("says how many did not fit, and only when some did not", () => {
    const base = { id: "a", name: "Box a", keys_sent: 64, keys_trimmed: 0, keys_sent_at: null };
    expect(keysLine(base)).toBe("Box a: 64 keys last sent.");
    expect(keysLine({ ...base, keys_trimmed: 3 })).toBe(
      "Box a: 64 keys last sent — 3 did not fit, so those members cannot be checked while it is offline.");
    expect(keysLine({ ...base, keys_sent: null })).toBe("Box a: no keys sent yet.");
  });
});

describe("the phases", () => {
  it("steps forward and back in order, and stops at the ends", () => {
    expect(phaseAfter("legacy")).toBe("v1");
    expect(phaseAfter("v1")).toBe("v1_only");
    expect(phaseAfter("v1_only")).toBeNull();
    expect(phaseBefore("legacy")).toBeNull();
    expect(phaseBefore("v1_only")).toBe("v1");
    expect(phaseAfter("something")).toBeNull();
  });
});

describe("the phase words (MCV1-04)", () => {
  it("never tells an admin phones show the old code — they have shown only the new one since the cut to v1 codes", () => {
    expect(PHASE_WORDS.legacy).not.toMatch(/phones still show the old code|old codes only/i);
    expect(PHASE_WORDS.legacy).toMatch(/phones show the new code/);
    expect(PHASE_WORDS.legacy).toMatch(/offline/);
    // The title the move dialogs cut from it still reads as a name.
    expect(PHASE_WORDS.legacy.split(" —")[0]).toBe("Before the switch");
  });
});
