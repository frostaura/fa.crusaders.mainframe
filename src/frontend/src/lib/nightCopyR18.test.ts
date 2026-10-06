import { describe, expect, it } from "vitest";
import { actorClause } from "./nightCopy";
import { buildTimeline, readableEvents } from "./nightTimeline";
import type { TraceEvent } from "./adminApi";

/**
 * R18 E18-3 (BE18b b5dc8044) — new Night kinds: `lights.restored` (a box re-energising a relay
 * after a power cut; actor `device`, no `code_holder`, subject the organiser) and the account kinds
 * `account.pin_set`, `pin_set_for_them`, `pin_cleared`, `fingerprint_enrolled`, `admin_inherited`.
 */

const OLGA = { user_id: "u-olga", name: "Olga Organiser" };
const DEVICE = { user_id: null, name: null, kind: "device", is_self: false } as const;
const COURT2 = { id: "c2", number: 2, name: "Court 2" };

describe("a lights restore names the board that reported it, never a code (E18-3)", () => {
  it("subject Olga and no code_holder: the court's board reported it", () => {
    const clause = actorClause(DEVICE, "Olga Organiser", OLGA, null, { kind: "lights.restored", court: COURT2 });
    expect(clause).toBe("reported by Court 2's board");
    expect(clause).not.toMatch(/code/);
  });

  it("a partner's Night (code_holder somehow set, no court name) still names no person", () => {
    const clause = actorClause(DEVICE, "Sam Partner", OLGA, { user_id: "u-sam", name: "Sam Partner" }, { kind: "lights.restored", court: null });
    expect(clause).toBe("reported by the court's board");
  });

  it("a lights-on row still names whose code lit it (R10 E10-2 kept)", () => {
    expect(actorClause(DEVICE, "Olga Organiser", OLGA, null, { kind: "lights.on", court: COURT2 }))
      .toBe("with Olga Organiser's code, at the board");
  });
});

describe("account kinds are worded truthfully (E18-3)", () => {
  const self = { user_id: "u1", name: "Thandi Mokoena", kind: "member", is_self: true } as const;
  const admin = { user_id: "u-a", name: "Review Admin", kind: "admin", is_self: false } as const;

  it("inherited admin rights: nobody granted them, the sign-in did — never 'by Thandi themselves'", () => {
    expect(actorClause(self, "Thandi Mokoena", null, null, { kind: "account.admin_inherited", court: null }))
      .toBe("when they signed in");
  });

  it.each(["account.pin_set", "account.pin_cleared"])("%s by the member is theirs", (kind) => {
    expect(actorClause(self, "Thandi Mokoena", null, null, { kind, court: null })).toBe("by Thandi Mokoena themselves");
  });

  it.each(["account.pin_set_for_them", "account.fingerprint_enrolled"])("%s at the desk names the admin", (kind) => {
    expect(actorClause(admin, "Thandi Mokoena", null, null, { kind, court: null })).toBe("by Review Admin, an admin");
  });
});

const AT = (s: number) => new Date(Date.parse("2026-10-06T16:00:00.000Z") + s * 1000).toISOString();
const ev = (strand: string, kind: string, s: number, extra: Partial<TraceEvent> = {}): TraceEvent =>
  ({ at: AT(s), strand, kind, headline: `${kind} ${s}`, source: "audit_log", source_id: `${kind}-${s}`, ...extra } as TraceEvent);

describe("the new kinds are grouped as their own stories (E18-3)", () => {
  it("three desk account changes in a minute are three rows, never '3 in 1 minute'", () => {
    const events = [
      ev("other", "account.pin_set_for_them", 0), ev("other", "account.fingerprint_enrolled", 20),
      ev("other", "account.pin_cleared", 40),
    ];
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("the same account change three times in a minute is still three rows", () => {
    const events = [ev("other", "account.pin_set", 0), ev("other", "account.pin_set", 10), ev("other", "account.pin_set", 20)];
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("a restore is never folded into the lights-on rows at the same court", () => {
    const court = { court: COURT2 };
    const events = [ev("lights", "lights.on", 0, court), ev("lights", "lights.on", 10, court), ev("lights", "lights.restored", 20, court)];
    const rows = buildTimeline(readableEvents(events));
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("the new kinds pass through with the server's headline, never the 'no word' sentence", () => {
    const out = readableEvents([ev("lights", "lights.restored", 0, { headline: "Court 2 lights came back on after a power cut" })]);
    expect(out[0].headline).toBe("Court 2 lights came back on after a power cut");
  });
});
