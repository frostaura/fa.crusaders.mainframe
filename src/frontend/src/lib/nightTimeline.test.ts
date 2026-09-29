import { describe, expect, it } from "vitest";
import {
  BURST_SECONDS, buildTimeline, burstOutcomes, durationInWords, hasApproximateTimes, readableEvents,
} from "./nightTimeline";
import { ACCOUNT_EVENT_WORDS, UNKNOWN_ACCOUNT_EVENT } from "./nightCopy";
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

describe("durations, as a person reads them", () => {
  it("writes minutes under the hour", () => {
    expect(durationInWords(4)).toBe("4m");
    expect(durationInWords(59)).toBe("59m");
  });

  it("writes hours and minutes over it", () => {
    expect(durationInWords(64)).toBe("1h 04m");
    expect(durationInWords(125)).toBe("2h 05m");
  });

  it("drops the minutes when there are none rather than writing 1h 00m", () => {
    expect(durationInWords(60)).toBe("1h");
    expect(durationInWords(120)).toBe("2h");
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
