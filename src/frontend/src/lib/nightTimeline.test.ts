import { describe, expect, it } from "vitest";
import {
  BURST_SECONDS, buildTimeline, burstOutcomes, durationInWords, hasApproximateTimes, readableEvents,
} from "./nightTimeline";
import { ACCOUNT_EVENT_WORDS, UNKNOWN_ACCOUNT_EVENT, burstSummary, gapLine } from "./nightCopy";
import type { TraceEvent } from "./adminApi";

/**
 * The night's reducer — every case is a boundary, because every decision here has one.
 *
 * <p>
 * Boundaries are what a reducer can get wrong, and the wrong side of each of these is
 * invisible on screen: two events that should have been one look like two things happening,
 * and an hour of nothing that is silently closed up looks like a continuous evening. Nobody
 * reviewing the page would notice either.
 * </p>
 */

const AT = (offsetSeconds: number): string =>
  new Date(Date.parse("2026-09-22T16:00:00.000Z") + offsetSeconds * 1000).toISOString();

function event(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    at: AT(0), strand: "door", kind: "door.refused", headline: "Refused at the Side Door",
    device_code: "GATE-1", ...overrides,
  };
}

describe("bursts — three tries at a door are one story", () => {
  it("collapses three of the same kind inside the window", () => {
    const rows = buildTimeline([
      event({ at: AT(0) }), event({ at: AT(20) }), event({ at: AT(40), kind: "door.opened" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("burst");
  });

  /**
   * The lower boundary. Two events are not a burst: hiding one of them behind a disclosure
   * costs a reader a click and buys nothing, and "a burst of 2" is a phrase nobody means.
   */
  it("leaves two alone, however close together", () => {
    const rows = buildTimeline([event({ at: AT(0) }), event({ at: AT(1) })]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event"]);
  });

  it("includes an event exactly on the window, because that is what 'within 60 seconds' means", () => {
    const rows = buildTimeline([
      event({ at: AT(0) }), event({ at: AT(30) }), event({ at: AT(BURST_SECONDS + 30) }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("burst");
  });

  it("breaks the run one second past the window", () => {
    const rows = buildTimeline([
      event({ at: AT(0) }), event({ at: AT(30) }), event({ at: AT(BURST_SECONDS + 31) }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  /**
   * Splitting a run by OUTCOME would put the interesting row — the one that worked — on its
   * own, while hiding the two refusals that explain it. The family and the device are the
   * key; the outcome is the story the burst tells.
   */
  it("keeps refused, refused, opened together as one door story", () => {
    const rows = buildTimeline([
      event({ at: AT(0), kind: "door.refused" }),
      event({ at: AT(20), kind: "door.refused" }),
      event({ at: AT(40), kind: "door.opened", headline: "Came in through the Side Door" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(burstOutcomes((rows[0] as { events: TraceEvent[] }).events))
      .toEqual(["Refused at the Side Door", "Refused at the Side Door", "Came in through the Side Door"]);
  });

  it("does not merge two different doors in one minute — that is two stories", () => {
    const rows = buildTimeline([
      event({ at: AT(0), device_code: "GATE-1" }),
      event({ at: AT(10), device_code: "GATE-2" }),
      event({ at: AT(20), device_code: "GATE-1" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  /**
   * R4 contract audit: the trace never sends `device_code`, so the rule above held only in this
   * file's fixture. The server names the door in `detail.door_name`.
   */
  it("does not merge two doors named only in the server's detail, as the trace really sends them", () => {
    const door = (at: number, name: string) => event({ at: AT(at), device_code: undefined, detail: { door_name: name } });
    const rows = buildTimeline([door(0, "Side Door"), door(10, "Front Door"), door(20, "Side Door")]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("does not merge a door scan with a wallet movement that happened beside it", () => {
    const rows = buildTimeline([
      event({ at: AT(0), strand: "door", kind: "door.opened" }),
      event({ at: AT(5), strand: "wallet", kind: "wallet.spent", device_code: "GATE-1" }),
      event({ at: AT(10), strand: "door", kind: "door.opened" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("names a kind the server has no word for in words, never as a raw code (F3.6)", () => {
    expect(burstOutcomes([event({ kind: "unrecognised", headline: null })])).toEqual([UNKNOWN_ACCOUNT_EVENT]);
    expect(burstOutcomes([event({ kind: "some.new_thing", headline: "" })])).toEqual(["some new thing"]);
  });
});

describe("gaps — nothing RECORDED, which is not nothing happening", () => {
  it("draws a gap longer than the threshold", () => {
    const rows = buildTimeline([event({ at: AT(0) }), event({ at: AT(31 * 60) })]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "gap", "event"]);
    expect((rows[1] as { minutes: number }).minutes).toBe(31);
  });

  it("does not draw one at twenty-nine minutes", () => {
    const rows = buildTimeline([event({ at: AT(0) }), event({ at: AT(29 * 60) })]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event"]);
  });

  it("does not draw one exactly on the threshold", () => {
    const rows = buildTimeline([event({ at: AT(0) }), event({ at: AT(30 * 60) })]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event"]);
  });

  /**
   * The mutant this kills: measuring the quiet from the START of a burst. A burst that ran
   * for two minutes would then make the silence afterwards look two minutes longer than it
   * was — and on this screen a duration is evidence somebody may be asked about.
   */
  it("measures the quiet from the last event of a burst, not its first", () => {
    const rows = buildTimeline([
      event({ at: AT(0) }), event({ at: AT(20) }), event({ at: AT(40) }),
      event({ at: AT(40 + 31 * 60), kind: "booking.made", strand: "booking" }),
    ]);
    const gap = rows.find((r) => r.kind === "gap") as { minutes: number };
    expect(gap.minutes, "the burst's own duration counted as silence").toBe(31);
  });

  it("never opens a night with a gap, because there is nothing to be quiet since", () => {
    const rows = buildTimeline([event({ at: AT(0) })]);
    expect(rows.map((r) => r.kind)).toEqual(["event"]);
  });

  it("handles an empty night without inventing anything", () => {
    expect(buildTimeline([])).toEqual([]);
  });
});

describe("durations, as a person reads them — and hears them (R9 X9-4)", () => {
  // The gap and the burst sit inside words a screen reader reads whole: "1h 04m" was heard as
  // "1 aitch 0 4 em". Spoken long form, the app's one wording (`minutesSpoken`).
  it("writes minutes under the hour", () => {
    expect(durationInWords(1)).toBe("1 minute");
    expect(durationInWords(4)).toBe("4 minutes");
    expect(durationInWords(59)).toBe("59 minutes");
  });

  it("writes hours and minutes over it", () => {
    expect(durationInWords(64)).toBe("1 hour 4 minutes");
    expect(durationInWords(125)).toBe("2 hours 5 minutes");
  });

  it("drops the minutes when there are none rather than writing 1 hour 0 minutes", () => {
    expect(durationInWords(60)).toBe("1 hour");
    expect(durationInWords(120)).toBe("2 hours");
  });

  it("the gap and the burst summary carry no compact unit", () => {
    expect(gapLine(durationInWords(64))).toBe("1 hour 4 minutes — nothing recorded");
    expect(burstSummary("12:10", 4, 1)).toBe("12:10 · 4 in 1 minute");
    expect(burstSummary("12:10", 3, 64)).not.toMatch(/\d ?(h|m|min)\b/);
  });
});

describe("money is never folded into a burst (R9 E9-3)", () => {
  const money = (at: number, amount: number | null, balance: number | null) => event({
    at: AT(at), strand: "wallet", kind: "minutes.moved", headline: "A share moved", source: "ledger",
    source_id: `l-${at}`, device_code: null, amount_minutes: amount, balance_after_minutes: balance,
  });

  it("three wallet rows in a minute stay three rows, each with its amount and balance", () => {
    const rows = buildTimeline([money(0, -30, 270), money(10, 7, 277), money(20, 60, 337)]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
    expect(rows.map((r) => (r.kind === "event" ? r.event.amount_minutes : null))).toEqual([-30, 7, 60]);
  });

  it("a row about somebody else's money (no amount on this member) is not grouped either", () => {
    const rows = buildTimeline([money(0, null, null), money(5, null, null), money(9, null, null)]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("a row carrying an amount on another strand is not grouped", () => {
    const rows = buildTimeline([
      event({ at: AT(0), strand: "booking", amount_minutes: -15 }),
      event({ at: AT(5), strand: "booking", amount_minutes: -15 }),
      event({ at: AT(9), strand: "booking", amount_minutes: -15 }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("a money row beside a door's burst stands on its own row", () => {
    const rows = buildTimeline([event({ at: AT(0) }), event({ at: AT(10) }), event({ at: AT(20) }), money(25, -30, 270)]);
    expect(rows.map((r) => r.kind)).toEqual(["burst", "event"]);
  });
});

describe("approximate times", () => {
  it("is true when any event carries one", () => {
    expect(hasApproximateTimes([event(), event({ approximate: true })])).toBe(true);
  });

  /**
   * Absent is not false in the sense that matters: a payload with no `approximate` field is
   * an API that has not shipped it, and the page must make no approximation claim either
   * way rather than asserting every time is exact.
   */
  it("is false when nothing says otherwise, which is the only claim available", () => {
    expect(hasApproximateTimes([event(), event()])).toBe(false);
    expect(hasApproximateTimes([event({ approximate: false })])).toBe(false);
  });
});

describe("readableEvents — no raw codes on a member's night (F3.6)", () => {
  const unknown = (raw: string, id: string): TraceEvent => ({
    at: "2026-09-21T18:00:00.000Z", kind: "unrecognised", source: "audit_log", source_id: id,
    headline: `Something this club's records have no word for (${raw})`,
  });

  it("puts every known account event into words", () => {
    const out = readableEvents([
      unknown("member.registered", "a1"), unknown("member.approved", "a2"), unknown("user.admin_granted", "a3"),
      unknown("user.admin_revoked", "a4"), unknown("member_code.rotated", "a5"), unknown("member.passkeys_revoked", "a6"),
    ]);
    expect(out.map((e) => e.headline)).toEqual([
      ACCOUNT_EVENT_WORDS["member.registered"], ACCOUNT_EVENT_WORDS["member.approved"],
      ACCOUNT_EVENT_WORDS["user.admin_granted"], ACCOUNT_EVENT_WORDS["user.admin_revoked"],
      ACCOUNT_EVENT_WORDS["member_code.rotated"], ACCOUNT_EVENT_WORDS["member.passkeys_revoked"],
    ]);
    expect(out.every((e) => !/[a-z]+[._][a-z]+/.test(e.headline ?? ""))).toBe(true);
  });

  it("shows a desk top-up once: the audit twin of the ledger movement is dropped", () => {
    const ledger: TraceEvent = { at: "2026-09-21T18:00:00.000Z", kind: "wallet.topped_up_at_the_desk", source: "ledger", source_id: "l1", headline: "Topped up at the desk" };
    const out = readableEvents([ledger, unknown("credit.adjusted", "a7"), { ...ledger }]);
    expect(out).toHaveLength(1);
    expect(out[0].headline).toBe("Topped up at the desk");
  });

  it("says a neutral sentence for an account event nobody has a word for", () => {
    expect(readableEvents([unknown("member.something_new", "a8")])[0].headline).toBe(UNKNOWN_ACCOUNT_EVENT);
  });
});

/**
 * R11 E11-4: a court box turning a used code away records what it was asked to do (`detail.attempt`:
 * the lights for a booking, a walk-up, paying for someone). Three different asks at one box in a
 * minute folded into "3 in 1 minute" with three identical "Court 1" rows — three stories, one row.
 */
describe("a box's refusals keep what each scan was trying to do (R11 E11-4)", () => {
  const refusal = (at: number, attempt: string | undefined) => event({
    at: AT(at), strand: "lights", kind: "court.refused", device_code: undefined,
    headline: "Was turned away at Court 1 — code already used",
    court: { id: "c1", number: 1, name: "Court 1" },
    detail: { reason: "code_used", ...(attempt ? { attempt } : {}) },
  });

  it("three different attempts in a minute stay three rows", () => {
    const rows = buildTimeline([refusal(0, "activate"), refusal(10, "walkup"), refusal(20, "pay_for")]);
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("three tries at the same thing are still one story", () => {
    const rows = buildTimeline([refusal(0, "walkup"), refusal(10, "walkup"), refusal(20, "walkup")]);
    expect(rows.map((r) => r.kind)).toEqual(["burst"]);
  });

  it("rows written before the field still fold as before", () => {
    const rows = buildTimeline([refusal(0, undefined), refusal(10, undefined), refusal(20, undefined)]);
    expect(rows.map((r) => r.kind)).toEqual(["burst"]);
  });
});
