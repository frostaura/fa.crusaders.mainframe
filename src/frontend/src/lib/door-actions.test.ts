import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOOR_EVENT_KIND_WORDS, DOOR_EVENT_WORDS, DOOR_FLEET_ACTIONS, DOOR_SCAN_ACTIONS,
  UNRECOGNISED_EVENT, classifyDoorRow, describeDoorEvent, describeDoorEventKind, isDoorScan,
} from "./deviceActivity";
import { NO_REASON_RECORDED, doorEventRows, doorRowRender } from "./doorsCopy";
import { type DeviceActivityEntry } from "./api";

/**
 * <b>The guard that would have caught B1, A2 and C4 — and did not exist.</b>
 *
 * <p>
 * `GET /admin/devices/{id}/activity` returns every `audit_log` row carrying a board's
 * `device_id`, which is a much larger set than "scans at this door": an admin renaming a
 * door writes `device.updated`, a board powering on writes `device.boot`, a club-wide shut
 * writes `doors.shut_all`. The door feed had a two-way test for its chip tone
 * (<code>startsWith("gate.denied") ? warning : success</code>) and a catch-all label of
 * "Refused", so every one of those rows rendered as a <b>green "Refused" chip</b>. North
 * gate's own page therefore announced "13 refused scans, newest 1 min ago" while the
 * overview said 0/0 and the club log and CSV had no rows for it at all — thirteen admin
 * edits. Editing a door added a refusal to its own page.
 * </p>
 *
 * <p>
 * Every unit test in the suite passed throughout, because every one of them was written on a
 * fixture built out of `gate.opened` and `gate.denied_*`. Nothing in the suite had ever seen
 * a `device.updated` row reach this screen. So the guard is not another hand-written fixture:
 * it <b>reads the backend's own sources at test time</b> and asserts that every audit action
 * the API can emit is classified. A new action lands as a red test on the screen that has to
 * render it, rather than as a green "Refused" chip in a club.
 * </p>
 */

/** Where the backend's sources live, relative to this file. */
const BACKEND = join(import.meta.dirname, "../../../backend/Crusaders.Mainframe.Api");

/** Every `"gate.x"` / `"device.x"` / `"doors.x"` literal the API can write to `audit_log`. */
function backendActions(): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { walk(path); continue; }
      if (!path.endsWith(".cs")) continue;
      for (const match of readFileSync(path, "utf8").matchAll(/"((?:gate|device|doors)\.[a-zA-Z_]+)"/g)) {
        found.add(match[1]);
      }
    }
  };
  walk(BACKEND);
  return [...found].sort();
}

function entry(overrides: Partial<DeviceActivityEntry> = {}): DeviceActivityEntry {
  return {
    at: "2026-09-19T10:00:00Z",
    action: "gate.opened",
    reason: "ok",
    offline: false,
    member: null,
    fingerprint: null,
    ...overrides,
  };
}

describe("the backend's own action vocabulary", () => {
  /**
   * A fail-loud floor. If the path ever moves, this test must go red rather than silently
   * passing over an empty list — which is the failure mode of every "scan the sources" guard
   * that has ever rotted.
   */
  it("finds the backend, and finds a realistic number of actions", () => {
    const actions = backendActions();
    // Twelve literals in the API project today. A floor rather than an equality, because a
    // new action must not fail THIS test — it must fail the classification one below, which
    // is the one that names the screen that has to render it.
    expect(actions.length, `read from ${BACKEND}`).toBeGreaterThan(10);
    expect(actions).toContain("gate.opened");
    expect(actions).toContain("device.updated");
    expect(actions).toContain("doors.shut_all");
  });

  /**
   * The whole finding, as one assertion: nothing the backend can write reaches the
   * `unknown` arm, so nothing can be rendered by a guess.
   */
  it("classifies every action the API can emit", () => {
    const unclassified = backendActions().filter((action) => {
      // The two the backend builds by concatenation and never writes bare. `gate.denied_`
      // and `device.gate_open_` are prefixes, and a prefix with nothing after it is not a
      // row that exists.
      if (action === "gate.denied_" || action === "device.gate_open_") return false;
      return classifyDoorRow(entry({ action })) === "unknown";
    });
    expect(unclassified, "add these to DOOR_EVENT_WORDS, or to the scan rules above it").toEqual([]);
  });

  /**
   * C4 exactly. The reviewer edited a door and watched a green "Refused" row appear on its
   * own page.
   */
  it("treats an admin edit and a registration as EVENTS, never as scans", () => {
    for (const action of ["device.updated", "device.auto_registered", "device.registered", "device.boot", "doors.shut_all"]) {
      expect(classifyDoorRow(entry({ action, reason: null })), action).toBe("event");
      expect(isDoorScan(entry({ action, reason: null })), action).toBe(false);
      const render = doorRowRender(entry({ action, reason: null }));
      expect(render.chip, action).toBeNull();
      expect(render.tone, action).toBe("muted");
    }
  });

  it("counts only the scan rows, on every surface that counts", () => {
    const rows = [
      entry({ action: "gate.opened" }),
      entry({ action: "gate.denied_too_early", reason: "too_early" }),
      entry({ action: "device.gate_open", reason: null, offline: true }),
      entry({ action: "device.unknown_scan", reason: null, offline: true }),
      entry({ action: "device.updated", reason: null }),
      entry({ action: "doors.shut_all", reason: null }),
    ];
    expect(rows.filter(isDoorScan)).toHaveLength(4);
  });
});

describe("doorRowRender", () => {
  /**
   * A2. Five refusals in eight on one reviewed screen were painted success-green, and the
   * twin of the same scan was amber. There is no input at all that can produce a green
   * refusal now, because the tone is not chosen at the call site any more.
   */
  it("never paints a refusal with a success tone, whatever the reason token is", () => {
    const reasons = [
      "too_early", "no_booking", "member_not_active", "not_recognised", "method_not_supported",
      "not_a_gate", "something_the_firmware_learned_last_week", "", null,
    ];
    for (const reason of reasons) {
      for (const action of ["gate.denied_x", "device.unknown_scan", "device.gate_open_not_a_gate"]) {
        const render = doorRowRender(entry({ action, reason }));
        expect(render.kind, `${action} / ${reason}`).toBe("refused");
        expect(render.tone, `${action} / ${reason}`).toBe("warning");
      }
    }
  });

  /** A2's second half: a refusal always has a reason line, or says it has none. */
  it("gives every refusal a reason line, even when the trail carries no reason", () => {
    for (const reason of [null, ""]) {
      const render = doorRowRender(entry({ action: "gate.denied_x", reason }));
      expect(render.detail).toBe(NO_REASON_RECORDED);
    }
    expect(doorRowRender(entry({ action: "gate.denied_too_early", reason: "too_early" })).detail)
      .toBe("Too early for that booking");
  });

  /**
   * B1's frontend rule: an action nobody has written copy for renders neutrally and carries
   * its raw token, rather than borrowing a chip from a decision it is not.
   */
  it("renders an unrecognised action neutrally, with its token", () => {
    const render = doorRowRender(entry({ action: "gate.somethingNobodyHasSeen", reason: null }));
    expect(render.kind).toBe("unknown");
    expect(render.chip).toBeNull();
    expect(render.tone).toBe("muted");
    expect(render.detail).toContain(UNRECOGNISED_EVENT);
    expect(render.detail).toContain("gate.somethingNobodyHasSeen");
  });

  it("keeps a released scan green and says the lock was released, never 'Opened'", () => {
    for (const action of ["gate.opened", "device.gate_open"]) {
      const render = doorRowRender(entry({ action, reason: action === "gate.opened" ? "ok" : null }));
      expect(render.kind, action).toBe("released");
      expect(render.tone, action).toBe("success");
      expect(render.chip, action).toBe("Lock released");
      expect(render.chip?.toLowerCase(), action).not.toContain("opened");
    }
  });
});

/**
 * <b>The nine scan actions, pinned against the rules that classify them.</b>
 *
 * WIRE-R1 §3 enumerates them, and `classifyDoorRow` reaches the same answer through prefix
 * rules. Two implementations of one fact is exactly how the original defect shipped — a
 * two-way test standing in for a four-way one — so they are asserted against each other in
 * BOTH directions rather than each being trusted on its own.
 */
describe("the scan-action set and the rules that classify it", () => {
  it("classifies every one of the nine as a scan", () => {
    for (const action of DOOR_SCAN_ACTIONS) {
      expect(isDoorScan(entry({ action })), action).toBe(true);
    }
  });

  it("classifies nothing else as a scan", () => {
    const notScans = [
      ...DOOR_FLEET_ACTIONS,
      "device.updated", "device.auto_registered", "device.registered", "device.deleted",
      "device.boot", "device.event_time_clamped", "device.api_key_regenerated",
      "device.activation", "device.release", "gate.somethingNobodyHasSeen",
    ];
    for (const action of notScans) {
      expect(isDoorScan(entry({ action })), action).toBe(false);
    }
  });

  /**
   * The five kinds the backend actually emits. `edited` covers rename, details change, shut
   * and reopen — the backend writes `device.updated` for all four and records nothing that
   * says which — so the copy for it must not guess at a verb.
   */
  it("reads every event kind, and guesses at no verb for `edited`", () => {
    const kinds = ["registered", "edited", "removed", "clock_corrected", "unrecognised"];
    for (const kind of kinds) {
      expect(DOOR_EVENT_KIND_WORDS[kind], kind).toBeTruthy();
    }
    const edited = DOOR_EVENT_KIND_WORDS.edited.toLowerCase();
    for (const guess of ["renamed", "shut", "reopened"]) {
      expect(edited, `"${guess}" in the \`edited\` sentence`).not.toContain(guess);
    }
    expect(edited).toContain("details or state");
  });

  it("takes the neutral arm for a kind nobody has written copy for", () => {
    expect(describeDoorEventKind({ at: "x", action: "device.propped_open", kind: "propped_open" }))
      .toBe(UNRECOGNISED_EVENT);
  });
});

describe("doorEventRows", () => {
  /**
   * The page must be right whether or not the API sends `events` yet, because the two lanes
   * land separately and a page that is only right against the new backend is a page that is
   * wrong in the meantime.
   */
  it("derives its own events from items when the API sends none", () => {
    const rows = doorEventRows([
      entry({ action: "gate.opened" }),
      entry({ at: "2026-09-19T09:00:00Z", action: "device.updated", reason: null }),
    ], undefined);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(DOOR_EVENT_WORDS["device.updated"]);
  });

  it("uses the API's own events where it sends them", () => {
    const rows = doorEventRows([entry({ action: "gate.opened" })], [
      { at: "2026-09-19T09:00:00Z", action: "device.updated", kind: "edited" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe(DOOR_EVENT_KIND_WORDS.edited);
    // No actor on the wire, so no row invents one.
    expect(rows[0].token).toBeNull();
  });

  /** During the changeover one fact can legitimately arrive down both paths. */
  it("does not print the same event twice while both paths are live", () => {
    const at = "2026-09-19T09:00:00Z";
    const rows = doorEventRows(
      [entry({ at, action: "device.updated", reason: null })],
      [{ at, action: "device.updated", kind: "edited" }],
    );
    expect(rows).toHaveLength(1);
  });

  it("never lets a scan into the events list", () => {
    const rows = doorEventRows([
      entry({ action: "gate.opened" }),
      entry({ action: "gate.denied_too_early", reason: "too_early" }),
      entry({ action: "device.gate_open", reason: null, offline: true }),
    ], []);
    expect(rows).toEqual([]);
  });

  it("puts the newest first", () => {
    const rows = doorEventRows(null, [
      { at: "2026-09-19T08:00:00Z", action: "device.updated", kind: "edited" },
      { at: "2026-09-19T09:00:00Z", action: "device.auto_registered", kind: "registered" },
    ]);
    expect(rows.map((r) => r.at)).toEqual(["2026-09-19T09:00:00Z", "2026-09-19T08:00:00Z"]);
  });

  it("reads an unknown event kind neutrally rather than guessing at it", () => {
    expect(describeDoorEventKind({ at: "x", action: "device.propped_open", kind: "propped_open" }))
      .toBe(UNRECOGNISED_EVENT);
    expect(describeDoorEvent(entry({ action: "device.nothing_like_this" }))).toBe(UNRECOGNISED_EVENT);
  });
});
