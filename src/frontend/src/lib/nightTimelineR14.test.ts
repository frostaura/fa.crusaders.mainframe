import { describe, expect, it } from "vitest";
import { buildTimeline, burstOutcomes, readableEvents } from "./nightTimeline";
import type { TraceEvent } from "./adminApi";

/**
 * R14 (BE14b §7) — the Night's new booking kinds: `booking.taken_off`, `booking.took_player_off`,
 * `booking.split_changed`, `booking.changed_split`, `booking.game_cancelled` (strand `booking`,
 * headlines composed by the server). There is no kind→icon map on this surface (the headline is
 * rendered as sent), so what can go wrong is the reducer: an organiser who takes a partner off,
 * changes the split and cancels inside a minute did three things to people, and folding them into
 * "3 in 1 minute" hid who was taken off and what the split became.
 */

const AT = (s: number) => new Date(Date.parse("2026-10-05T16:00:00.000Z") + s * 1000).toISOString();
const COURT = { id: "c1", number: 1, name: "Court 1" };

function act(kind: string, headline: string, s: number): TraceEvent {
  return { at: AT(s), strand: "booking", kind, headline, court: COURT, actor: { kind: "member", name: "Olive Organiser" } } as TraceEvent;
}

const ORGANISER = [
  act("booking.took_player_off", "Took Sam Partner off Court 1", 0),
  act("booking.changed_split", "Changed how Court 1 is split — Alex Partner's share is now 8 minutes", 20),
  act("booking.game_cancelled", "Olive Organiser cancelled their game on Court 1", 40),
];
const PARTNER = [
  act("booking.taken_off", "Olive Organiser took them off Court 1", 0),
  act("booking.split_changed", "Olive Organiser changed how Court 1 is split — their share is now 8 minutes", 15),
  act("booking.game_cancelled", "The club cancelled their game on Court 1", 30),
];

describe("R14 — a player's acts on a booking are never folded into a burst", () => {
  it.each([["the organiser's night", ORGANISER], ["the partner's night", PARTNER]])("%s: every act on its own row, with its headline", (_n, events) => {
    const rows = buildTimeline(readableEvents(events));
    expect(rows.map((r) => r.kind)).toEqual(["event", "event", "event"]);
    expect(burstOutcomes(events)).toEqual(events.map((e) => e.headline));
  });

  it("a kind with no headline is said in words, never as its raw code", () => {
    expect(burstOutcomes([{ ...ORGANISER[0], headline: null }])).toEqual(["booking took player off"]);
  });
});
