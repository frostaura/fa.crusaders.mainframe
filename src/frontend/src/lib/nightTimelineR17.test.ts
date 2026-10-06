import { describe, expect, it } from "vitest";
import { buildTimeline, readableEvents } from "./nightTimeline";
import type { TraceEvent } from "./adminApi";

/**
 * R17 E17-8 / J17-4 (BE17c 9488f7fc) — a member's own seat acts (invited, accepted, declined, from
 * each side) and every partner's check-in are on the Night now. Each is one person's story: three
 * in a minute are three rows, never "3 in 1 minute".
 */

const AT = (s: number) => new Date(Date.parse("2026-10-06T16:00:00.000Z") + s * 1000).toISOString();
const COURT = { id: "c1", number: 1, name: "Court 1" };
const row = (strand: string, kind: string, s: number): TraceEvent =>
  ({ at: AT(s), strand, kind, headline: `${kind} headline ${s}`, court: COURT, actor: { kind: "member", name: "Sam" } } as TraceEvent);

const SEAT_ACTS = [
  "booking.invited", "booking.invited_player", "booking.accepted",
  "booking.partner_accepted", "booking.declined", "booking.partner_declined",
];

describe("R17 — seat acts and check-ins are never folded into a burst", () => {
  it.each(SEAT_ACTS)("%s: three in a minute are three rows", (kind) => {
    const events = [row("booking", kind, 0), row("booking", kind, 15), row("booking", kind, 30)];
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });

  it("court.checked_in: three partners scanning in one minute are three rows", () => {
    const events = [row("court", "court.checked_in", 0), row("court", "court.checked_in", 20), row("court", "court.checked_in", 40)];
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });
});
