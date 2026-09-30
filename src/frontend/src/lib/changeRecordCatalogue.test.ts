import { describe, expect, it } from "vitest";
import { changeHeadline, presentChanges } from "./changeRecordCopy";
import { CHANGE_RECORD_CATALOGUE, rawIn, serverChangeActions, type ChangeRecordFixture } from "../test/changeRecordCatalogue";

/**
 * Review round 4, A4-6 — "change record: nothing raw for ANY action". Every action in
 * `AdminChangeActions.cs`, with what its writer really stores rendered as the server really
 * renders it, must reach the page in words: no JSON, no ISO date or instant, no id, no enum or
 * code token, no unit abbreviation, no empty row, and no figure repeated under a second label.
 */

const TIMEZONE = "Africa/Johannesburg";

/** Pairs the reviewer read as one figure said twice (A4-6: "a Total repeating the Event count"). */
const REPEATS: Array<[string, string]> = [["event_count", "total"], ["rows", "total"]];

function name(f: ChangeRecordFixture): string {
  return f.variant ? `${f.action} (${f.variant})` : f.action;
}

/** Every problem on one fixture's rendered row, as "where: "text" — reason". */
function problems(f: ChangeRecordFixture): string[] {
  const out: string[] = [];
  const check = (where: string, text: string | null | undefined, field?: string) => {
    const reason = rawIn(text, field);
    if (reason) out.push(`${where}: ${JSON.stringify(text)} — ${reason}`);
  };

  check("headline", changeHeadline({ headline: f.headline, action: f.action }));
  const { changed, facts } = presentChanges({ area: f.area, action: f.action, changes: f.changes }, TIMEZONE);

  for (const c of changed) {
    check(`${c.field} label`, c.label);
    if (c.before === null && c.after === null) out.push(`${c.field}: a row with nothing on either side`);
    check(`${c.field} before [${c.label}]`, c.before, c.field);
    check(`${c.field} after [${c.label}]`, c.after, c.field);
  }
  for (const fact of facts) {
    check(`${fact.field} label`, fact.label);
    check(`${fact.field} fact [${fact.label}]`, fact.value, fact.field);
  }

  const shown = new Map<string, string>();
  for (const c of changed) shown.set(c.field, `${c.before ?? ""}→${c.after ?? ""}`);
  for (const fact of facts) shown.set(fact.field, fact.value);
  for (const [a, b] of REPEATS) {
    if (shown.has(a) && shown.has(b) && shown.get(a) === shown.get(b)) {
      out.push(`${b}: ${JSON.stringify(shown.get(b))} — repeats ${a} under a second label`);
    }
  }
  return out;
}

describe("the change record catalogue covers the server's whole vocabulary (A4-6)", () => {
  it("has a fixture for every action AdminChangeActions.cs declares", () => {
    const declared = serverChangeActions();
    expect(declared.length).toBeGreaterThan(40);
    const covered = new Set(CHANGE_RECORD_CATALOGUE.map((f) => f.action));
    expect(declared.filter((a) => !covered.has(a))).toEqual([]);
  });

  it("names no action the server does not declare", () => {
    const declared = new Set(serverChangeActions());
    expect(CHANGE_RECORD_CATALOGUE.map((f) => f.action).filter((a) => !declared.has(a))).toEqual([]);
  });
});

describe("rawIn — the rules themselves", () => {
  it.each([
    ["{\"to\": \"2026-09-29T22:00:00+00:00\"}", "JSON (a brace or bracket)"],
    ["2026-10-06", "an ISO date or instant"],
    ["ce45e706-b3ee-458e-abe2-8b69d932be6f", "an id (UUID)"],
    ["InheritCourt", "a PascalCase enum token (InheritCourt)"],
    ["best_of_5", "a snake_case code (best_of_5)"],
    ["booking.created,booking.cancelled", "a dotted event/action code (booking.created)"],
    ["Multiplier bps", "a unit abbreviation (bps)"],
    ["tue 18:00-21:00", "a lowercase weekday code (tue)"],
    ["booking, door, other", "a list of lowercase codes"],
    ["", "an empty value on a row that is shown"],
    ["Credits per", "a caption that stops mid-phrase"],
  ])("flags %j", (text, reason) => {
    expect(rawIn(text)).toBe(reason);
  });

  it.each(["Sends to", "Wed 30 Sep, 18:00", "80.00 cr", "Tue, Thu", "Active", "Every week", "https://hooks.example.org", "Thandi Mokoena"])(
    "passes %j",
    (text) => {
      expect(rawIn(text)).toBeNull();
    },
  );

  it("flags a lowercase state token only on a state field", () => {
    expect(rawIn("archived", "status")).toBe("a lowercase state token (archived)");
    expect(rawIn("archived")).toBeNull();
  });
});

describe("nothing raw reaches the change record, for any action (A4-6)", () => {
  it.each(CHANGE_RECORD_CATALOGUE.map((f) => [name(f), f] as const))("%s", (title, fixture) => {
    const found = problems(fixture);
    expect(found, `${title}:\n  ${found.join("\n  ")}`).toEqual([]);
  });
});
