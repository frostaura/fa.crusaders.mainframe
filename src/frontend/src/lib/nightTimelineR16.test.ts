import { describe, expect, it } from "vitest";
import { buildTimeline, readableEvents } from "./nightTimeline";
import type { TraceEvent } from "./adminApi";

/**
 * R16 E16-1 / J16-5 (BE16b) — the club's accept-on-behalf is now on the Nights, from each side:
 * the partner's, the organiser's and the admin's. Each a story of its own, never folded.
 */

const AT = (s: number) => new Date(Date.parse("2026-10-05T16:00:00.000Z") + s * 1000).toISOString();
const COURT = { id: "c1", number: 1, name: "Court 1" };
const act = (kind: string, s: number): TraceEvent =>
  ({ at: AT(s), strand: "booking", kind, headline: `${kind} headline ${s}`, court: COURT, actor: { kind: "admin", name: "The club" } } as TraceEvent);

const KINDS = ["booking.accepted_for_them", "booking.club_accepted_player", "booking.accepted_for_player"];

describe("R16 — the club's accept-on-behalf is never folded into a burst", () => {
  it.each(KINDS)("%s: three in a minute are three rows", (kind) => {
    const events = [act(kind, 0), act(kind, 15), act(kind, 30)];
    expect(buildTimeline(readableEvents(events)).map((r) => r.kind)).toEqual(["event", "event", "event"]);
  });
});
